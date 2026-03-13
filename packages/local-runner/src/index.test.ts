import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ExecutorAdapter, RunHandle } from "@devagent-runner/core";
import { afterEach, beforeEach, test } from "vitest";
import type {
  ArtifactRef,
  TaskExecutionEvent,
  TaskExecutionRequest,
  TaskExecutionResult,
} from "@devagent-sdk/types";
import { PROTOCOL_VERSION } from "@devagent-sdk/types";
import { LocalRunner, FileSystemWorkspaceManager, fileExists, readEventLog } from "./index.js";

let runnerRoot = "";

beforeEach(async () => {
  runnerRoot = await mkdtemp(join(tmpdir(), "devagent-runner-root-"));
  process.env.DEVAGENT_RUNNER_ROOT = runnerRoot;
});

afterEach(async () => {
  delete process.env.DEVAGENT_RUNNER_ROOT;
  if (runnerRoot) {
    await rm(runnerRoot, { recursive: true, force: true });
  }
});

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devagent-runner-"));
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "README.md"), "runner test\n");
  return root;
}

async function createRealGitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "devagent-runner-git-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Codex"], { cwd: root });
  await writeFile(join(root, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root });
  return root;
}

function createRequest(sourceRepoPath: string, taskId = "task-1"): TaskExecutionRequest {
  const workspaceId = "workspace-1";
  const repositoryId = "repo-1";
  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId,
    taskType: "triage",
    workspaceRef: {
      id: workspaceId,
      name: "Runner Workspace",
      provider: "github",
      primaryRepositoryId: repositoryId,
    },
    repositories: [{
      id: repositoryId,
      workspaceId,
      alias: "primary",
      name: "repo",
      repoRoot: sourceRepoPath,
      repoFullName: "example/repo",
      defaultBranch: "main",
      provider: "github",
    }],
    workItem: {
      id: "item-1",
      kind: "github-issue",
      externalId: "1",
      title: "Runner test issue",
      repositoryId,
    },
    execution: {
      primaryRepositoryId: repositoryId,
      repositories: [{
        repositoryId,
        alias: "primary",
        sourceRepoPath,
        workBranch: "devagent/workflow/shared-branch",
        isolation: "temp-copy",
      }],
    },
    targetRepositoryIds: [repositoryId],
    executor: {
      executorId: "devagent",
    },
    constraints: {},
    capabilities: {
      canSyncTasks: true,
      canCreateTask: true,
      canComment: true,
      canReview: true,
      canMerge: true,
      canOpenReviewable: true,
    },
    context: {
      summary: "test",
    },
    expectedArtifacts: ["triage-report"],
  };
}

class StaticHandle implements RunHandle {
  constructor(
    readonly id: string,
    private readonly result: Promise<TaskExecutionResult>,
    private readonly onCancel: () => Promise<void> = async () => {},
  ) {}

  status(): "running" | "success" | "failed" | "cancelled" {
    return "running";
  }

  wait(): Promise<TaskExecutionResult> {
    return this.result;
  }

  cancel(): Promise<void> {
    return this.onCancel();
  }
}

class OrderedFakeAdapter implements ExecutorAdapter {
  executorId(): string {
    return "devagent";
  }

  canHandle(): boolean {
    return true;
  }

  async launch(
    request: TaskExecutionRequest,
    _workspacePath: string,
    _repositoryPaths: Record<string, string>,
    artifactDir: string,
    onEvent: (event: TaskExecutionEvent) => void,
  ): Promise<RunHandle> {
    const artifactPath = join(artifactDir, "triage-report.md");
    await writeFile(artifactPath, "# Triage\n");
    const artifact: ArtifactRef = {
      kind: "triage-report",
      path: artifactPath,
      createdAt: new Date().toISOString(),
    };
    onEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: "started",
      at: new Date().toISOString(),
      taskId: request.taskId,
    });
    onEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: "progress",
      at: new Date().toISOString(),
      taskId: request.taskId,
      message: "working",
    });
    onEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: "artifact",
      at: new Date().toISOString(),
      taskId: request.taskId,
      artifact,
    });
    onEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: "completed",
      at: new Date().toISOString(),
      taskId: request.taskId,
      status: "success",
    });

    return new StaticHandle("run-ordered", Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      taskId: request.taskId,
      status: "success",
      artifacts: [artifact],
      metrics: {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 1,
      },
    }));
  }
}

class ContractFakeAdapter extends OrderedFakeAdapter {}

class RunnerFinalizedAdapter implements ExecutorAdapter {
  constructor(private readonly mutateWorkspace = false) {}

  executorId(): string {
    return "codex";
  }

  canHandle(): boolean {
    return true;
  }

  handlesFinalEvents(): boolean {
    return false;
  }

  async launch(
    request: TaskExecutionRequest,
    workspacePath: string,
    _repositoryPaths: Record<string, string>,
    artifactDir: string,
    onEvent: (event: TaskExecutionEvent) => void,
  ): Promise<RunHandle> {
    onEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: "started",
      at: new Date().toISOString(),
      taskId: request.taskId,
    });
    onEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: "progress",
      at: new Date().toISOString(),
      taskId: request.taskId,
      message: "runner finalized adapter in progress",
    });

    const result = (async (): Promise<TaskExecutionResult> => {
      if (this.mutateWorkspace) {
        await writeFile(join(workspacePath, "README.md"), "mutated\n");
      }
      const artifactPath = join(artifactDir, "triage-report.md");
      await writeFile(artifactPath, "# Triage\n\nRunner finalized output\n");
      return {
        protocolVersion: PROTOCOL_VERSION,
        taskId: request.taskId,
        status: "success",
        artifacts: [{
          kind: "triage-report",
          path: artifactPath,
          createdAt: new Date().toISOString(),
        }],
        metrics: {
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 1,
        },
      };
    })();

    return new StaticHandle("run-runner-finalized", result);
  }
}

class SleepHandle implements RunHandle {
  private readonly done = new EventEmitter();
  private resolved = false;
  private result: TaskExecutionResult | null = null;
  readonly pid: number | undefined;

  constructor(
    readonly id: string,
    private readonly child: ChildProcess,
    private readonly taskId: string,
  ) {
    this.pid = child.pid ?? undefined;
    child.once("exit", () => {
      if (!this.resolved) {
        this.result = {
          protocolVersion: PROTOCOL_VERSION,
          taskId,
          status: "cancelled",
          artifacts: [],
          metrics: {
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: 1,
          },
        };
        this.resolved = true;
        this.done.emit("done");
      }
    });
  }

  status(): "running" | "success" | "failed" | "cancelled" {
    return this.resolved ? (this.result?.status ?? "cancelled") : "running";
  }

  wait(): Promise<TaskExecutionResult> {
    if (this.result) return Promise.resolve(this.result);
    return new Promise((resolve) => {
      this.done.once("done", () => resolve(this.result!));
    });
  }

  async cancel(): Promise<void> {
    this.child.kill("SIGTERM");
  }
}

class SleepingAdapter implements ExecutorAdapter {
  executorId(): string {
    return "devagent";
  }

  canHandle(): boolean {
    return true;
  }

  async launch(
    request: TaskExecutionRequest,
    _workspacePath: string,
    _repositoryPaths: Record<string, string>,
    _artifactDir: string,
    onEvent: (event: TaskExecutionEvent) => void,
  ): Promise<RunHandle> {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 10000)"], {
      stdio: "ignore",
    });
    onEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: "started",
      at: new Date().toISOString(),
      taskId: request.taskId,
    });
    return new SleepHandle("run-cancel", child, request.taskId);
  }
}

test("workspace manager prepares temp copies", async () => {
  const repo = await createRepo();
  const manager = new FileSystemWorkspaceManager();
  const { workspacePath } = await manager.prepare({
    primaryRepositoryId: "repo-1",
    repositories: [{
      repositoryId: "repo-1",
      alias: "primary",
      sourceRepoPath: repo,
      workBranch: "devagent/test/1",
      isolation: "temp-copy",
    }],
  });
  assert.equal(await fileExists(join(workspacePath, "repos", "primary", "README.md")), true);
  assert.equal(workspacePath.startsWith(runnerRoot), true);
  assert.equal(await fileExists(join(repo, ".devagent-runner")), false);
  await manager.cleanup(workspacePath);
  assert.equal(await fileExists(workspacePath), false);
});

test("workspace manager links node_modules into prepared workspaces when available", async () => {
  const repo = await createRepo();
  await mkdir(join(repo, "node_modules"), { recursive: true });
  await writeFile(join(repo, "node_modules", ".placeholder"), "ok\n");
  const manager = new FileSystemWorkspaceManager();

  const { workspacePath } = await manager.prepare({
    primaryRepositoryId: "repo-1",
    repositories: [{
      repositoryId: "repo-1",
      alias: "primary",
      sourceRepoPath: repo,
      workBranch: "devagent/test/node-modules",
      isolation: "temp-copy",
    }],
  });

  assert.equal(await fileExists(join(workspacePath, "repos", "primary", "node_modules")), true);
  assert.equal(await readFile(join(workspacePath, "repos", "primary", "node_modules", ".placeholder"), "utf-8"), "ok\n");
  assert.equal(existsSync(join(workspacePath, "repos", "primary", "node_modules", ".placeholder")), true);
  await manager.cleanup(workspacePath);
});

test("workspace manager exposes node_modules entries inside git workspaces", async () => {
  const repo = await createRealGitRepo();
  await mkdir(join(repo, "node_modules"), { recursive: true });
  await writeFile(join(repo, "node_modules", ".placeholder"), "ok\n");
  const manager = new FileSystemWorkspaceManager();

  const { workspacePath } = await manager.prepare({
    primaryRepositoryId: "repo-1",
    repositories: [{
      repositoryId: "repo-1",
      alias: "primary",
      sourceRepoPath: repo,
      workBranch: "devagent/workflow/node-modules-ignore",
      isolation: "git-worktree",
      baseRef: "main",
    }],
  });
  const repoWorkspacePath = join(workspacePath, "repos", "primary");

  const status = execFileSync("git", ["status", "--short"], {
    cwd: repoWorkspacePath,
    encoding: "utf-8",
  }).trim();
  assert.equal(status, "");
  assert.equal(await readFile(join(repoWorkspacePath, "node_modules", ".placeholder"), "utf-8"), "ok\n");
  await manager.cleanup(workspacePath);
});

test("workspace manager reopens an existing git branch without resetting it", async () => {
  const repo = await createRealGitRepo();
  const manager = new FileSystemWorkspaceManager();
  const spec = {
    primaryRepositoryId: "repo-1",
    repositories: [{
      repositoryId: "repo-1",
      alias: "primary",
      sourceRepoPath: repo,
      workBranch: "devagent/workflow/reopen-branch",
      isolation: "git-worktree" as const,
      baseRef: "main",
    }],
  };

  const first = await manager.prepare(spec);
  const firstRepoWorkspacePath = join(first.workspacePath, "repos", "primary");
  await writeFile(join(firstRepoWorkspacePath, "README.md"), "branch change\n");
  execFileSync("git", ["add", "README.md"], { cwd: firstRepoWorkspacePath });
  execFileSync("git", ["commit", "-m", "branch change"], { cwd: firstRepoWorkspacePath });
  await manager.cleanup(first.workspacePath);

  const reopened = await manager.prepare(spec);
  assert.equal(await readFile(join(reopened.workspacePath, "repos", "primary", "README.md"), "utf-8"), "branch change\n");
  await manager.cleanup(reopened.workspacePath);
});

test("workspace manager keeps git workspaces clean when the source repo is dirty", async () => {
  const repo = await createRealGitRepo();
  await writeFile(join(repo, "vitest.config.ts"), "export default {};\n");
  const manager = new FileSystemWorkspaceManager();

  const { workspacePath } = await manager.prepare({
    primaryRepositoryId: "repo-1",
    repositories: [{
      repositoryId: "repo-1",
      alias: "primary",
      sourceRepoPath: repo,
      workBranch: "devagent/workflow/overlay-working-tree",
      isolation: "git-worktree",
      baseRef: "main",
    }],
  });

  assert.equal(await fileExists(join(workspacePath, "repos", "primary", "vitest.config.ts")), false);
  await manager.cleanup(workspacePath);
});

test("local runner emits a warning when it ignores dirty source changes for git worktrees", async () => {
  const repo = await createRealGitRepo();
  await writeFile(join(repo, "vitest.config.ts"), "export default {};\n");
  const runner = new LocalRunner({
    adapters: [new OrderedFakeAdapter()],
  });
  const request = createRequest(repo, "task-dirty-git-worktree");
  request.execution.repositories[0]!.isolation = "git-worktree";
  request.execution.repositories[0]!.baseRef = "main";

  const { runId } = await runner.startTask(request);
  await runner.awaitResult(runId);
  const metadata = await runner.inspect(runId);
  const events = await readEventLog(metadata.eventLogPath);

  assert.equal(
    events.some((event) =>
      event.type === "log" &&
      event.message.includes("ignored local uncommitted source-repo changes"),
    ),
    true,
  );
});

test("local runner records artifacts and result metadata", async () => {
  const repo = await createRepo();
  const runner = new LocalRunner({
    adapters: [new ContractFakeAdapter()],
  });
  const { runId } = await runner.startTask(createRequest(repo));
  const result = await runner.awaitResult(runId);
  const metadata = await runner.inspect(runId);

  assert.equal(result.status, "success");
  assert.equal(result.artifacts.length, 1);
  assert.equal(existsSync(result.artifacts[0]!.path), true);
  assert.deepEqual(JSON.parse(await readFile(metadata.resultPath, "utf-8")), result);
});

test("local runner replays events in emitted order", async () => {
  const repo = await createRepo();
  const runner = new LocalRunner({
    adapters: [new OrderedFakeAdapter()],
  });
  const { runId } = await runner.startTask(createRequest(repo, "task-ordered"));
  await runner.awaitResult(runId);
  const metadata = await runner.inspect(runId);
  const events = await readEventLog(metadata.eventLogPath);

  assert.deepEqual(events.map((event) => event.type), ["started", "progress", "artifact", "completed"]);
});

test("local runner supports cancellation for an active subprocess", async () => {
  const repo = await createRepo();
  const runner = new LocalRunner({
    adapters: [new SleepingAdapter()],
  });
  const { runId } = await runner.startTask(createRequest(repo, "task-cancel"));
  await runner.cancel(runId);
  const result = await runner.awaitResult(runId);

  assert.equal(result.status, "cancelled");
});

test("local runner supports cancellation from a fresh process instance", async () => {
  const repo = await createRepo();
  const runner = new LocalRunner({
    adapters: [new SleepingAdapter()],
  });
  const { runId } = await runner.startTask(createRequest(repo, "task-cross-process-cancel"));

  const restored = new LocalRunner({
    adapters: [new SleepingAdapter()],
  });
  const previousCwd = process.cwd();
  process.chdir(repo);
  await restored.cancel(runId);
  process.chdir(previousCwd);

  const result = await runner.awaitResult(runId);
  assert.equal(result.status, "cancelled");
});

test("local runner reports inactive cancellations as invalid requests", async () => {
  const repo = await createRepo();
  const runner = new LocalRunner({
    adapters: [new ContractFakeAdapter()],
  });
  const { runId } = await runner.startTask(createRequest(repo, "task-inactive-cancel"));
  await runner.awaitResult(runId);

  await assert.rejects(
    () => runner.cancel(runId),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INVALID_REQUEST");
      return true;
    },
  );
});

test("local runner fails a run that exceeds timeoutSec", async () => {
  const repo = await createRepo();
  const runner = new LocalRunner({
    adapters: [new SleepingAdapter()],
  });
  const request = createRequest(repo, "task-timeout");
  request.constraints.timeoutSec = 1;

  const { runId } = await runner.startTask(request);
  const result = await runner.awaitResult(runId);

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "EXECUTION_FAILED");
  assert.equal(result.error?.message, "Task exceeded timeoutSec (1)");
});

test("local runner reads finished runs from persisted metadata", async () => {
  const repo = await createRepo();
  const runner = new LocalRunner({
    adapters: [new ContractFakeAdapter()],
  });
  const { runId } = await runner.startTask(createRequest(repo, "task-persisted"));
  await runner.awaitResult(runId);

  const restored = new LocalRunner({
    adapters: [new ContractFakeAdapter()],
  });
  const metadata = await restored.inspect(runId);
  const result = await restored.awaitResult(runId);

  assert.equal(metadata.taskId, "task-persisted");
  assert.equal(result.status, "success");
  assert.equal(metadata.workspacePath.startsWith(runnerRoot), true);
});

test("local runner rejects invalid persisted results", async () => {
  const repo = await createRepo();
  const runner = new LocalRunner({
    adapters: [new ContractFakeAdapter()],
  });
  const { runId } = await runner.startTask(createRequest(repo, "task-invalid-result"));
  await runner.awaitResult(runId);
  const metadata = await runner.inspect(runId);
  await writeFile(metadata.resultPath, JSON.stringify({ nope: true }, null, 2));

  const restored = new LocalRunner({
    adapters: [new ContractFakeAdapter()],
  });
  await assert.rejects(() => restored.awaitResult(runId));
});

test("readEventLog rejects invalid protocol events", async () => {
  const eventLogPath = join(runnerRoot, "events", "invalid.jsonl");
  await mkdir(join(runnerRoot, "events"), { recursive: true });
  await writeFile(eventLogPath, `${JSON.stringify({ nope: true })}\n`);

  await assert.rejects(() => readEventLog(eventLogPath));
});

test("local runner finalizes artifact and completed events for structured adapters", async () => {
  const repo = await createRepo();
  const runner = new LocalRunner({
    adapters: [new RunnerFinalizedAdapter()],
  });
  const request = createRequest(repo, "task-structured-events");
  request.executor.executorId = "codex";

  const { runId } = await runner.startTask(request);
  await runner.awaitResult(runId);
  const metadata = await runner.inspect(runId);
  const events = await readEventLog(metadata.eventLogPath);

  assert.deepEqual(events.map((event) => event.type), ["started", "progress", "artifact", "completed"]);
});

test("local runner fails non-devagent executors that modify read-only workspaces", async () => {
  const repo = await createRepo();
  const runner = new LocalRunner({
    adapters: [new RunnerFinalizedAdapter(true)],
  });
  const request = createRequest(repo, "task-readonly-violation");
  request.executor.executorId = "codex";
  request.execution.repositories[0]!.readOnly = true;

  const { runId } = await runner.startTask(request);
  const result = await runner.awaitResult(runId);

  assert.equal(result.status, "failed");
  assert.equal(result.error?.message, "Executor codex modified a read-only workspace.");
});
