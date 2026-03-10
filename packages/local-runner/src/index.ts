import { EventEmitter } from "node:events";
import { appendFile, mkdir, readFile, rm, writeFile, cp, stat, readdir, symlink, lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import {
  type ExecutorAdapter,
  type RunHandle,
  type RunStatus,
  type RunnerClient,
  type WorkspaceManager,
  RunnerError,
  TrackedRunHandle,
} from "@devagent-runner/core";
import { validateTaskExecutionEvent, validateTaskExecutionResult } from "@devagent-sdk/validation";
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
  status: RunStatus;
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
  return fileExists(join(path, ".git"));
}

async function execFileAsync(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
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
  return await new Promise<string>((resolve, reject) => {
    execFile(command, args, { cwd, encoding: "utf-8" }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function ignoreWorkspaceEntry(workspacePath: string, entry: string): Promise<void> {
  try {
    const rawExcludePath = (await execFileStdout("git", ["rev-parse", "--git-path", "info/exclude"], workspacePath)).trim();
    const excludePath = isAbsolute(rawExcludePath) ? rawExcludePath : join(workspacePath, rawExcludePath);
    await mkdir(dirname(excludePath), { recursive: true });
    const current = await fileExists(excludePath) ? await readFile(excludePath, "utf-8") : "";
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
  if (!await fileExists(sourceNodeModules) || await fileExists(workspaceNodeModules)) {
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
    if (await fileExists(workspacePath)) {
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
    if (await fileExists(gitDir)) {
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

class LocalRunHandle extends TrackedRunHandle {
  constructor(
    readonly id: string,
    resultPromise: Promise<TaskExecutionResult>,
    private readonly cancelFn: () => Promise<void>,
  ) {
    super(id, undefined, resultPromise);
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
    let eventLogWrite = Promise.resolve();
    let eventLogError: unknown;

    const emitter = new EventEmitter();
    let workspacePath: string;
    try {
      ({ workspacePath } = await this.workspaceManager.prepare(request.workspace));
    } catch (error) {
      throw new RunnerError("WORKSPACE_PREPARE_FAILED", error instanceof Error ? error.message : String(error));
    }

    const onEvent = (event: TaskExecutionEvent): void => {
      eventLogWrite = eventLogWrite
        .then(async () => {
          await appendFile(eventLogPath, `${JSON.stringify(event)}\n`);
        })
        .catch((error: unknown) => {
          eventLogError ??= error;
        });
      emitter.emit("event", event);
    };

    const flushEventLog = async (): Promise<void> => {
      await eventLogWrite;
      if (eventLogError) {
        throw eventLogError;
      }
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
      pid: handle.pid,
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
        await flushEventLog();
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
    for (const event of await readEventLog(metadata.eventLogPath)) {
      onEvent(event);
    }
  }

  async cancel(runId: string): Promise<void> {
    const run = this.activeRuns.get(runId);
    if (!run) {
      const metadata = await this.inspect(runId);
      if (metadata.status !== "running" || !metadata.pid) {
        throw new RunnerError("INVALID_REQUEST", `Run ${runId} is not active`);
      }
      try {
        process.kill(metadata.pid, "SIGTERM");
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          throw new RunnerError("INVALID_REQUEST", `Run ${runId} is not active`);
        }
        throw new RunnerError(
          "EXECUTION_FAILED",
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
    return validateTaskExecutionResult(JSON.parse(resultRaw));
  }

  async inspect(runId: string): Promise<RunMetadata> {
    const active = this.activeRuns.get(runId);
    if (active) return active.metadata;
    const known = this.knownRuns.get(runId);
    if (known) return known;

    const cwdGuess = process.cwd();
    const candidate = join(workspaceRootFor(cwdGuess), "runs", `${runId}.json`);
    if (!await fileExists(candidate)) {
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
  if (!await fileExists(eventLogPath)) return [];
  const raw = await readFile(eventLogPath, "utf-8");
  return raw
    .split("\n")
    .filter((line: string) => line.trim())
    .map((line: string) => validateTaskExecutionEvent(JSON.parse(line)));
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
