import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ExecutorAdapter, RunHandle } from "@devagent-runner/core";
import type {
  ArtifactRef,
  TaskExecutionEvent,
  TaskExecutionRequest,
  TaskExecutionResult,
} from "@devagent-sdk/types";
import { PROTOCOL_VERSION } from "@devagent-sdk/types";
import { LocalRunner, FileSystemWorkspaceManager, fileExists, readEventLog } from "./index.js";

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
  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId,
    taskType: "triage",
    project: { id: "p1", name: "repo" },
    workItem: { kind: "github-issue", externalId: "1" },
    workspace: {
      sourceRepoPath,
      workBranch: "devagent/workflow/shared-branch",
      isolation: "temp-copy",
    },
    executor: {
      executorId: "devagent",
    },
    constraints: {},
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
    sourceRepoPath: repo,
    workBranch: "devagent/test/1",
    isolation: "temp-copy",
  });
  assert.equal(await fileExists(join(workspacePath, "README.md")), true);
  await manager.cleanup(workspacePath);
  assert.equal(await fileExists(workspacePath), false);
});

test("workspace manager links node_modules into prepared workspaces when available", async () => {
  const repo = await createRepo();
  await mkdir(join(repo, "node_modules"), { recursive: true });
  await writeFile(join(repo, "node_modules", ".placeholder"), "ok\n");
  const manager = new FileSystemWorkspaceManager();

  const { workspacePath } = await manager.prepare({
    sourceRepoPath: repo,
    workBranch: "devagent/test/node-modules",
    isolation: "temp-copy",
  });

  assert.equal(await fileExists(join(workspacePath, "node_modules")), true);
  assert.equal(await readFile(join(workspacePath, "node_modules", ".placeholder"), "utf-8"), "ok\n");
  await manager.cleanup(workspacePath);
});

test("workspace manager ignores linked node_modules in git workspaces", async () => {
  const repo = await createRealGitRepo();
  await mkdir(join(repo, "node_modules"), { recursive: true });
  await writeFile(join(repo, "node_modules", ".placeholder"), "ok\n");
  const manager = new FileSystemWorkspaceManager();

  const { workspacePath } = await manager.prepare({
    sourceRepoPath: repo,
    workBranch: "devagent/workflow/node-modules-ignore",
    isolation: "git-worktree",
    baseRef: "main",
  });

  const status = execFileSync("git", ["status", "--short"], {
    cwd: workspacePath,
    encoding: "utf-8",
  }).trim();
  assert.equal(status, "");
  await manager.cleanup(workspacePath);
});

test("workspace manager reopens an existing git branch without resetting it", async () => {
  const repo = await createRealGitRepo();
  const manager = new FileSystemWorkspaceManager();
  const spec = {
    sourceRepoPath: repo,
    workBranch: "devagent/workflow/reopen-branch",
    isolation: "git-worktree" as const,
    baseRef: "main",
  };

  const first = await manager.prepare(spec);
  await writeFile(join(first.workspacePath, "README.md"), "branch change\n");
  execFileSync("git", ["add", "README.md"], { cwd: first.workspacePath });
  execFileSync("git", ["commit", "-m", "branch change"], { cwd: first.workspacePath });
  await manager.cleanup(first.workspacePath);

  const reopened = await manager.prepare(spec);
  assert.equal(await readFile(join(reopened.workspacePath, "README.md"), "utf-8"), "branch change\n");
  await manager.cleanup(reopened.workspacePath);
});

test("workspace manager overlays uncommitted working tree files into git workspaces", async () => {
  const repo = await createRealGitRepo();
  await writeFile(join(repo, "vitest.config.ts"), "export default {};\n");
  const manager = new FileSystemWorkspaceManager();

  const { workspacePath } = await manager.prepare({
    sourceRepoPath: repo,
    workBranch: "devagent/workflow/overlay-working-tree",
    isolation: "git-worktree",
    baseRef: "main",
  });

  assert.equal(await readFile(join(workspacePath, "vitest.config.ts"), "utf-8"), "export default {};\n");
  await manager.cleanup(workspacePath);
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
  const previousCwd = process.cwd();
  process.chdir(repo);
  const metadata = await restored.inspect(runId);
  const result = await restored.awaitResult(runId);
  process.chdir(previousCwd);

  assert.equal(metadata.taskId, "task-persisted");
  assert.equal(result.status, "success");
});
