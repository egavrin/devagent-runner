import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, writeFile, cp, stat, readdir, symlink, lstat } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  type ExecutorAdapter,
  type RunHandle,
  type RunnerClient,
  type WorkspaceManager,
  RunnerError,
} from "@devagent-runner/core";
import type {
  TaskExecutionEvent,
  TaskExecutionRequest,
  TaskExecutionResult,
  WorkspaceSpec,
} from "@devagent-sdk/types";
import { PROTOCOL_VERSION } from "@devagent-sdk/types";

type RunMetadata = {
  runId: string;
  taskId: string;
  taskType: string;
  status: "running" | "success" | "failed" | "cancelled";
  artifactDir: string;
  eventLogPath: string;
  workspacePath: string;
  pid?: number;
  resultPath: string;
};

type ManagedRun = {
  emitter: EventEmitter;
  handle: RunHandle;
  metadata: RunMetadata;
};

function workspaceRootFor(repoPath: string): string {
  return join(repoPath, ".devagent-runner");
}

async function isGitRepo(path: string): Promise<boolean> {
  return existsSync(join(path, ".git"));
}

async function execFileAsync(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(command, args, { cwd }, (error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoPath);
    return true;
  } catch {
    return false;
  }
}

async function execFileStdout(command: string, args: string[], cwd: string): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(command, args, { cwd, encoding: "utf-8" }, (error, stdout) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise(stdout);
    });
  });
}

async function ignoreWorkspaceEntry(workspacePath: string, entry: string): Promise<void> {
  try {
    const rawExcludePath = (await execFileStdout("git", ["rev-parse", "--git-path", "info/exclude"], workspacePath)).trim();
    const excludePath = isAbsolute(rawExcludePath) ? rawExcludePath : join(workspacePath, rawExcludePath);
    await mkdir(dirname(excludePath), { recursive: true });
    const current = existsSync(excludePath) ? await readFile(excludePath, "utf-8") : "";
    const lines = current.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.includes(entry) || lines.includes(`/${entry}`)) {
      return;
    }
    const next = current.endsWith("\n") || current.length === 0 ? `${current}/${entry}\n` : `${current}\n/${entry}\n`;
    await writeFile(excludePath, next);
  } catch {
    // Temp copies or non-git workspaces do not need git excludes.
  }
}

async function copyRepoContents(sourceRepoPath: string, workspacePath: string): Promise<void> {
  await mkdir(workspacePath, { recursive: true });
  for (const entry of await readdir(sourceRepoPath)) {
    if (entry === ".devagent-runner" || entry === ".git" || entry === "node_modules") continue;
    await cp(join(sourceRepoPath, entry), join(workspacePath, entry), { recursive: true });
  }
}

async function overlayGitWorkingTreeChanges(sourceRepoPath: string, workspacePath: string): Promise<void> {
  const rawStatus = await execFileStdout("git", ["status", "--porcelain"], sourceRepoPath);
  const entries = rawStatus
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  for (const entry of entries) {
    const status = entry.slice(0, 2);
    const rawPath = entry.slice(3);
    const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
    if (!path || path.startsWith(".git") || path.startsWith(".devagent-runner") || path.startsWith("node_modules")) {
      continue;
    }

    const sourcePath = join(sourceRepoPath, path);
    const workspacePathTarget = join(workspacePath, path);
    if (status.includes("D")) {
      await rm(workspacePathTarget, { recursive: true, force: true });
      continue;
    }

    await mkdir(dirname(workspacePathTarget), { recursive: true });
    await cp(sourcePath, workspacePathTarget, { recursive: true });
  }
}

async function linkSharedDependencies(sourceRepoPath: string, workspacePath: string): Promise<void> {
  const sourceNodeModules = join(sourceRepoPath, "node_modules");
  const workspaceNodeModules = join(workspacePath, "node_modules");
  if (!existsSync(sourceNodeModules) || existsSync(workspaceNodeModules)) {
    return;
  }

  const sourceStats = await lstat(sourceNodeModules);
  if (!sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) {
    return;
  }

  const relativeTarget = resolve(sourceNodeModules);
  await symlink(relativeTarget, workspaceNodeModules, "dir");
  await ignoreWorkspaceEntry(workspacePath, "node_modules");
}

function safeWorkspaceName(workBranch: string): string {
  const normalized = workBranch.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "workspace";
}

function createTimeoutResult(request: TaskExecutionRequest, startedAt: string): TaskExecutionResult {
  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: request.taskId,
    status: "failed",
    artifacts: [],
    metrics: {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
    },
    error: {
      code: "EXECUTION_FAILED",
      message: `Task exceeded timeoutSec (${request.constraints.timeoutSec})`,
    },
  };
}

export class FileSystemWorkspaceManager implements WorkspaceManager {
  async prepare(spec: WorkspaceSpec): Promise<{ workspacePath: string }> {
    const runnerRoot = workspaceRootFor(spec.sourceRepoPath);
    const workspacesRoot = join(runnerRoot, "workspaces");
    const workspacePath = join(workspacesRoot, safeWorkspaceName(spec.workBranch));
    await mkdir(workspacesRoot, { recursive: true });
    if (existsSync(workspacePath)) {
      return { workspacePath };
    }

    if (spec.isolation === "git-worktree" && await isGitRepo(spec.sourceRepoPath)) {
      try {
        const worktreeArgs = await branchExists(spec.sourceRepoPath, spec.workBranch)
          ? ["worktree", "add", workspacePath, spec.workBranch]
          : ["worktree", "add", "-B", spec.workBranch, workspacePath, spec.baseRef ?? "HEAD"];
        await execFileAsync("git", worktreeArgs, spec.sourceRepoPath);
        await overlayGitWorkingTreeChanges(spec.sourceRepoPath, workspacePath);
        await linkSharedDependencies(spec.sourceRepoPath, workspacePath);
        return { workspacePath };
      } catch {
        await copyRepoContents(spec.sourceRepoPath, workspacePath);
        await linkSharedDependencies(spec.sourceRepoPath, workspacePath);
        return { workspacePath };
      }
    }

    await copyRepoContents(spec.sourceRepoPath, workspacePath);
    await linkSharedDependencies(spec.sourceRepoPath, workspacePath);
    return { workspacePath };
  }

  async cleanup(workspacePath: string): Promise<void> {
    const gitDir = join(workspacePath, ".git");
    if (existsSync(gitDir)) {
      try {
        await execFileAsync("git", ["worktree", "remove", "--force", workspacePath], workspacePath);
        return;
      } catch {
        // Fall through to rm on temp copies and already-detached paths.
      }
    }
    await rm(workspacePath, { recursive: true, force: true });
  }
}

class LocalRunHandle implements RunHandle {
  private currentStatus: "running" | "success" | "failed" | "cancelled" = "running";

  constructor(
    readonly id: string,
    private readonly resultPromise: Promise<TaskExecutionResult>,
    private readonly cancelFn: () => Promise<void>,
  ) {
    void this.resultPromise.then((result) => {
      this.currentStatus = result.status;
    }).catch(() => {
      this.currentStatus = "failed";
    });
  }

  status(): "running" | "success" | "failed" | "cancelled" {
    return this.currentStatus;
  }

  wait(): Promise<TaskExecutionResult> {
    return this.resultPromise;
  }

  cancel(): Promise<void> {
    return this.cancelFn();
  }
}

export class LocalRunner implements RunnerClient {
  private readonly adapters: ExecutorAdapter[];
  private readonly workspaceManager: WorkspaceManager;
  private readonly activeRuns = new Map<string, ManagedRun>();
  private readonly knownRuns = new Map<string, RunMetadata>();

  constructor(options: {
    adapters: ExecutorAdapter[];
    workspaceManager?: WorkspaceManager;
  }) {
    this.adapters = options.adapters;
    this.workspaceManager = options.workspaceManager ?? new FileSystemWorkspaceManager();
  }

  async startTask(request: TaskExecutionRequest): Promise<{ runId: string }> {
    const adapter = this.adapters.find((candidate) => candidate.canHandle(request.executor));
    if (!adapter) {
      throw new RunnerError("EXECUTOR_NOT_FOUND", `No adapter found for executor ${request.executor.executorId}`);
    }

    const runnerRoot = workspaceRootFor(request.workspace.sourceRepoPath);
    const artifactDir = join(runnerRoot, "artifacts", request.taskId);
    const eventsDir = join(runnerRoot, "events");
    const runsDir = join(runnerRoot, "runs");
    await mkdir(artifactDir, { recursive: true });
    await mkdir(eventsDir, { recursive: true });
    await mkdir(runsDir, { recursive: true });
    const eventLogPath = join(eventsDir, `${request.taskId}.jsonl`);
    const resultPath = join(artifactDir, "result.json");

    const emitter = new EventEmitter();
    let workspacePath = "";
    try {
      ({ workspacePath } = await this.workspaceManager.prepare(request.workspace));
    } catch (error) {
      throw new RunnerError("WORKSPACE_PREPARE_FAILED", error instanceof Error ? error.message : String(error));
    }

    const onEvent = (event: TaskExecutionEvent): void => {
      appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`);
      emitter.emit("event", event);
    };

    const handle = await adapter.launch(request, workspacePath, artifactDir, onEvent);
    const metadata: RunMetadata = {
      runId: handle.id,
      taskId: request.taskId,
      taskType: request.taskType,
      status: "running",
      artifactDir,
      eventLogPath,
      workspacePath,
      pid: (handle as RunHandle & { pid?: number }).pid,
      resultPath,
    };
    await writeFile(join(runsDir, `${handle.id}.json`), JSON.stringify(metadata, null, 2));
    this.knownRuns.set(handle.id, metadata);

    const startedAt = new Date().toISOString();
    const resultPromise = handle.wait();
    const timedPromise = request.constraints.timeoutSec && request.constraints.timeoutSec > 0
      ? new Promise<TaskExecutionResult>((resolve) => {
          const timeoutMs = request.constraints.timeoutSec! * 1000;
          const timer = setTimeout(async () => {
            try {
              await handle.cancel();
            } catch {
              // Best-effort cancel.
            }
            const timeoutResult = createTimeoutResult(request, startedAt);
            onEvent({
              protocolVersion: PROTOCOL_VERSION,
              type: "completed",
              at: timeoutResult.metrics.finishedAt,
              taskId: request.taskId,
              status: timeoutResult.status,
            });
            resolve(timeoutResult);
          }, timeoutMs);

          void resultPromise.finally(() => clearTimeout(timer));
        })
      : null;

    const wrappedHandle = new LocalRunHandle(
      handle.id,
      Promise.race([resultPromise, ...(timedPromise ? [timedPromise] : [])]).then(async (result: TaskExecutionResult) => {
        metadata.status = result.status;
        await writeFile(resultPath, JSON.stringify(result, null, 2));
        await writeFile(join(runsDir, `${handle.id}.json`), JSON.stringify(metadata, null, 2));
        this.activeRuns.delete(handle.id);
        this.knownRuns.set(handle.id, metadata);
        return result;
      }).catch(async (error: unknown) => {
        metadata.status = "failed";
        await writeFile(join(runsDir, `${handle.id}.json`), JSON.stringify(metadata, null, 2));
        this.activeRuns.delete(handle.id);
        this.knownRuns.set(handle.id, metadata);
        throw error;
      }),
      async () => {
        await handle.cancel();
      },
    );

    this.activeRuns.set(handle.id, { emitter, handle: wrappedHandle, metadata });
    return { runId: handle.id };
  }

  async subscribe(runId: string, onEvent: (event: TaskExecutionEvent) => void): Promise<void> {
    const run = this.activeRuns.get(runId);
    if (run) {
      run.emitter.on("event", onEvent);
      return;
    }

    const metadata = await this.inspect(runId);
    const contents = await readFile(metadata.eventLogPath, "utf-8");
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line) as TaskExecutionEvent);
    }
  }

  async cancel(runId: string): Promise<void> {
    const run = this.activeRuns.get(runId);
    if (!run) {
      const metadata = await this.inspect(runId);
      if (metadata.status !== "running" || !metadata.pid) {
        throw new RunnerError("CANCELLED", `Run ${runId} is not active`);
      }
      try {
        process.kill(metadata.pid, "SIGTERM");
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          throw new RunnerError("CANCELLED", `Run ${runId} is not active`);
        }
        throw new RunnerError(
          "CANCELLED",
          error instanceof Error ? error.message : `Unable to cancel run ${runId}`,
        );
      }
    }
    await run.handle.cancel();
  }

  async awaitResult(runId: string): Promise<TaskExecutionResult> {
    const run = this.activeRuns.get(runId);
    if (run) {
      return run.handle.wait();
    }
    const metadata = await this.inspect(runId);
    const resultRaw = await readFile(metadata.resultPath, "utf-8");
    return JSON.parse(resultRaw) as TaskExecutionResult;
  }

  async inspect(runId: string): Promise<RunMetadata> {
    const active = this.activeRuns.get(runId);
    if (active) return active.metadata;
    const known = this.knownRuns.get(runId);
    if (known) return known;

    const cwdGuess = process.cwd();
    const candidate = join(workspaceRootFor(cwdGuess), "runs", `${runId}.json`);
    if (!existsSync(candidate)) {
      throw new RunnerError("INVALID_REQUEST", `Unknown run ${runId}`);
    }
    return JSON.parse(await readFile(candidate, "utf-8")) as RunMetadata;
  }

  async cleanupRun(runId: string): Promise<void> {
    const metadata = await this.inspect(runId);
    await this.workspaceManager.cleanup(metadata.workspacePath);
  }
}

export async function readEventLog(eventLogPath: string): Promise<TaskExecutionEvent[]> {
  if (!existsSync(eventLogPath)) return [];
  const raw = await readFile(eventLogPath, "utf-8");
  return raw
    .split("\n")
    .filter((line: string) => line.trim())
    .map((line: string) => JSON.parse(line) as TaskExecutionEvent);
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
