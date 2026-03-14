import { EventEmitter } from "node:events";
import { appendFile, mkdir, readFile, rm, writeFile, cp, stat, readdir, symlink, lstat, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  type ExecutorAdapter,
  type RunHandle,
  type RunStatus,
  type RunnerClient,
  type WorkspaceManager,
  primaryRepositorySpec,
  RunnerError,
  TrackedRunHandle,
} from "@devagent-runner/core";
import { validateTaskExecutionEvent, validateTaskExecutionResult } from "@devagent-sdk/validation";
import type {
  RepositoryWorkspaceSpec,
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
  repositoryPaths: Record<string, string>;
  pid?: number;
  resultPath: string;
};

type ManagedRun = {
  emitter: EventEmitter;
  handle: RunHandle;
  metadata: RunMetadata;
};

function workspaceRootFor(repoPath: string): string {
  const override = process.env.DEVAGENT_RUNNER_ROOT?.trim();
  if (override) {
    return resolve(override);
  }
  return join(homedir(), ".devagent-runner");
}

function repositoryWorkspacePath(workspacePath: string, alias: string): string {
  return join(workspacePath, "repos", alias);
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

async function prepareRepositoryWorkspace(
  spec: RepositoryWorkspaceSpec,
  targetPath: string,
): Promise<void> {
  if (await fileExists(targetPath)) {
    return;
  }

  if (spec.isolation === "git-worktree" && await isGitRepo(spec.sourceRepoPath)) {
    try {
      const worktreeArgs = await branchExists(spec.sourceRepoPath, spec.workBranch)
        ? ["worktree", "add", targetPath, spec.workBranch]
        : ["worktree", "add", "-B", spec.workBranch, targetPath, spec.baseRef ?? "HEAD"];
      await execFileAsync("git", worktreeArgs, spec.sourceRepoPath);
      await linkSharedDependencies(spec.sourceRepoPath, targetPath);
      return;
    } catch {
      await copyRepoContents(spec.sourceRepoPath, targetPath);
      await linkSharedDependencies(spec.sourceRepoPath, targetPath);
      return;
    }
  }

  await copyRepoContents(spec.sourceRepoPath, targetPath);
  await linkSharedDependencies(spec.sourceRepoPath, targetPath);
}

async function cleanupRepositoryWorkspace(path: string): Promise<void> {
  const gitDir = join(path, ".git");
  if (await fileExists(gitDir)) {
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", path], path);
      return;
    } catch {
      // Fall through to rm on temp copies and already-detached paths.
    }
  }
  await rm(path, { recursive: true, force: true });
}

async function hasDirtyWorkingTree(sourceRepoPath: string): Promise<boolean> {
  try {
    const rawStatus = await execFileStdout("git", ["status", "--porcelain"], sourceRepoPath);
    return rawStatus
      .split("\n")
      .map((line) => line.trimEnd())
      .some((line) => {
        if (!line) return false;
        const rawPath = line.slice(3);
        const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
        return Boolean(
          path &&
          !path.startsWith(".git") &&
          !path.startsWith(".devagent-runner") &&
          !path.startsWith("node_modules"),
        );
      });
  } catch {
    return false;
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

  await mkdir(workspaceNodeModules, { recursive: true });
  for (const entry of await readdir(sourceNodeModules)) {
    const sourceEntry = join(sourceNodeModules, entry);
    const workspaceEntry = join(workspaceNodeModules, entry);
    if (await fileExists(workspaceEntry)) {
      continue;
    }
    await symlink(resolve(sourceEntry), workspaceEntry, "junction");
  }
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

async function fingerprintWorkspace(path: string): Promise<string> {
  const hash = createHash("sha256");

  async function visit(currentPath: string, relativePath: string): Promise<void> {
    const stats = await lstat(currentPath);
    if (stats.isSymbolicLink()) {
      hash.update(`link:${relativePath}:${await readLinkSafe(currentPath)}\n`);
      return;
    }

    if (stats.isDirectory()) {
      const entries = (await readdir(currentPath)).sort();
      for (const entry of entries) {
        if (entry === ".git" || entry === ".devagent-runner" || entry === "node_modules") {
          continue;
        }
        const childRelative = relativePath ? `${relativePath}/${entry}` : entry;
        await visit(join(currentPath, entry), childRelative);
      }
      return;
    }

    hash.update(`file:${relativePath}\n`);
    hash.update(await readFile(currentPath));
    hash.update("\n");
  }

  await visit(path, "");
  return hash.digest("hex");
}

async function readLinkSafe(path: string): Promise<string> {
  try {
    return await readlink(path);
  } catch {
    return "";
  }
}

async function fingerprintReadonlyRepositories(
  request: TaskExecutionRequest,
  repositoryPaths: Record<string, string>,
): Promise<Map<string, string>> {
  const fingerprints = new Map<string, string>();
  for (const repository of request.execution.repositories) {
    if (!repository.readOnly) {
      continue;
    }
    const repositoryPath = repositoryPaths[repository.repositoryId];
    if (!repositoryPath) {
      continue;
    }
    fingerprints.set(repository.repositoryId, await fingerprintWorkspace(repositoryPath));
  }
  return fingerprints;
}

function enforceReadOnlyResult(
  request: TaskExecutionRequest,
  result: TaskExecutionResult,
): TaskExecutionResult {
  return {
    ...result,
    status: "failed",
    error: {
      code: "EXECUTION_FAILED",
      message: `Executor ${request.executor.executorId} modified a read-only workspace.`,
    },
  };
}

export class FileSystemWorkspaceManager implements WorkspaceManager {
  async prepare(spec: WorkspaceSpec): Promise<{
    workspacePath: string;
    repositoryPaths: Record<string, string>;
  }> {
    const primary = primaryRepositorySpec(spec);
    const runnerRoot = workspaceRootFor(primary.sourceRepoPath);
    const workspacesRoot = join(runnerRoot, "workspaces");
    const workspacePath = join(workspacesRoot, safeWorkspaceName(primary.workBranch));
    const repositoriesRoot = join(workspacePath, "repos");
    await mkdir(repositoriesRoot, { recursive: true });

    const repositoryPaths: Record<string, string> = {};
    for (const repository of spec.repositories) {
      const repoPath = repositoryWorkspacePath(workspacePath, repository.alias);
      await prepareRepositoryWorkspace(repository, repoPath);
      repositoryPaths[repository.repositoryId] = repoPath;
    }

    return { workspacePath, repositoryPaths };
  }

  async cleanup(workspacePath: string): Promise<void> {
    const reposRoot = join(workspacePath, "repos");
    if (await fileExists(reposRoot)) {
      for (const entry of await readdir(reposRoot)) {
        await cleanupRepositoryWorkspace(join(reposRoot, entry));
      }
      await rm(workspacePath, { recursive: true, force: true });
      return;
    }
    await cleanupRepositoryWorkspace(workspacePath);
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

    const primaryExecution = primaryRepositorySpec(request.execution);
    const runnerRoot = workspaceRootFor(primaryExecution.sourceRepoPath);
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
    let repositoryPaths: Record<string, string>;
    try {
      ({ workspacePath, repositoryPaths } = await this.workspaceManager.prepare(request.execution));
    } catch (error) {
      throw new RunnerError("WORKSPACE_PREPARE_FAILED", error instanceof Error ? error.message : String(error));
    }
    const runnerFinalizesEvents = !(adapter.handlesFinalEvents?.() ?? true);
    const initialReadonlyFingerprints = request.execution.repositories.some((repository) => repository.readOnly)
      ? await fingerprintReadonlyRepositories(request, repositoryPaths)
      : null;

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

    const hasDirtySourceRepo = (
      await Promise.all(
        request.execution.repositories
          .filter((repository) => repository.isolation === "git-worktree")
          .map(async (repository) => await hasDirtyWorkingTree(repository.sourceRepoPath)),
      )
    ).some(Boolean);

    if (hasDirtySourceRepo) {
      onEvent({
        protocolVersion: PROTOCOL_VERSION,
        type: "log",
        at: new Date().toISOString(),
        taskId: request.taskId,
        stream: "stdout",
        message: "Runner ignored local uncommitted source-repo changes and used a clean isolated workspace.",
      });
    }

    const handle = await adapter.launch(request, workspacePath, repositoryPaths, artifactDir, onEvent);
    const metadata: RunMetadata = {
      runId: handle.id,
      taskId: request.taskId,
      taskType: request.taskType,
      status: "running",
      artifactDir,
      eventLogPath,
      workspacePath,
      repositoryPaths,
      pid: handle.pid,
      resultPath,
    };
    await writeFile(join(runsDir, `${handle.id}.json`), JSON.stringify(metadata, null, 2));
    this.knownRuns.set(handle.id, metadata);

    const startedAt = new Date().toISOString();
    const resultPromise = handle.wait();
    let timedOut = false;
    const timedPromise = request.constraints.timeoutSec && request.constraints.timeoutSec > 0
      ? new Promise<TaskExecutionResult>((resolve) => {
          const timeoutMs = request.constraints.timeoutSec! * 1000;
          const timer = setTimeout(async () => {
            try {
              await handle.cancel();
            } catch {
              // Best-effort cancel.
            }
            timedOut = true;
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
        let finalResult = result;
        if (initialReadonlyFingerprints) {
          const finalReadonlyFingerprints = await fingerprintReadonlyRepositories(request, repositoryPaths);
          const readOnlyWorkspaceChanged = [...initialReadonlyFingerprints.entries()].some(([repositoryId, fingerprint]) =>
            finalReadonlyFingerprints.get(repositoryId) !== fingerprint
          );
          if (readOnlyWorkspaceChanged) {
            finalResult = enforceReadOnlyResult(request, finalResult);
          }
        }
        if (runnerFinalizesEvents && !timedOut) {
          if (finalResult.artifacts[0]) {
            onEvent({
              protocolVersion: PROTOCOL_VERSION,
              type: "artifact",
              at: new Date().toISOString(),
              taskId: request.taskId,
              artifact: finalResult.artifacts[0],
            });
          }
          onEvent({
            protocolVersion: PROTOCOL_VERSION,
            type: "completed",
            at: new Date().toISOString(),
            taskId: request.taskId,
            status: finalResult.status,
          });
        }
        metadata.status = finalResult.status;
        await flushEventLog();
        await writeFile(resultPath, JSON.stringify(finalResult, null, 2));
        await writeFile(join(runsDir, `${handle.id}.json`), JSON.stringify(metadata, null, 2));
        this.activeRuns.delete(handle.id);
        this.knownRuns.set(handle.id, metadata);
        return finalResult;
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

    const candidate = join(workspaceRootFor(process.cwd()), "runs", `${runId}.json`);
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
