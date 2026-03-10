import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  ClaudeAdapter,
  CodexAdapter,
  DevAgentAdapter,
  OpenCodeAdapter,
} from "./index.js";
import type { ExecutorAdapter } from "@devagent-runner/core";
import type { TaskExecutionEvent, TaskExecutionRequest, TaskExecutionResult } from "@devagent-sdk/types";
import { PROTOCOL_VERSION } from "@devagent-sdk/types";

async function createWorkspace(): Promise<{ root: string; artifactDir: string; workspacePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "devagent-adapter-"));
  const artifactDir = join(root, "artifacts");
  const workspacePath = join(root, "workspace");
  await mkdir(artifactDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  return { root, artifactDir, workspacePath };
}

function createRequest(executorId: TaskExecutionRequest["executor"]["executorId"]): TaskExecutionRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: `task-${executorId}`,
    taskType: "triage",
    project: { id: "p1", name: "repo" },
    workItem: { kind: "github-issue", externalId: "1", title: "Smoke test" },
    workspace: {
      sourceRepoPath: "/tmp/repo",
      workBranch: `devagent/${executorId}/task`,
      isolation: "temp-copy",
    },
    executor: { executorId, model: "test-model" },
    constraints: {},
    context: { summary: "smoke" },
    expectedArtifacts: ["triage-report"],
  };
}

async function createStub(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function collectEvents(
  adapter: ExecutorAdapter,
  request: TaskExecutionRequest,
  workspacePath: string,
  artifactDir: string,
): Promise<{ events: TaskExecutionEvent[]; result: TaskExecutionResult }> {
  const events: TaskExecutionEvent[] = [];
  const handle = await adapter.launch(request, workspacePath, artifactDir, (event) => {
    events.push(event);
  });
  return {
    events,
    result: await handle.wait(),
  };
}

test("DevAgentAdapter smoke test with stub executable", async () => {
  const { root, artifactDir, workspacePath } = await createWorkspace();
  const stubPath = join(root, "devagent-stub.js");
  await createStub(stubPath, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const requestPath = args[args.indexOf("--request") + 1];
const artifactDir = args[args.indexOf("--artifact-dir") + 1];
const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
const artifactPath = path.join(artifactDir, "triage-report.md");
const resultPath = path.join(artifactDir, "result.json");
fs.writeFileSync(artifactPath, "# Triage\\n\\nStub output\\n");
process.stdout.write(JSON.stringify({ protocolVersion: "0.1", type: "started", at: new Date().toISOString(), taskId: request.taskId }) + "\\n");
process.stdout.write(JSON.stringify({ protocolVersion: "0.1", type: "artifact", at: new Date().toISOString(), taskId: request.taskId, artifact: { kind: "triage-report", path: artifactPath, createdAt: new Date().toISOString() } }) + "\\n");
fs.writeFileSync(resultPath, JSON.stringify({ protocolVersion: "0.1", taskId: request.taskId, status: "success", artifacts: [{ kind: "triage-report", path: artifactPath, createdAt: new Date().toISOString() }], metrics: { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1 } }, null, 2));
process.stdout.write(JSON.stringify({ protocolVersion: "0.1", type: "completed", at: new Date().toISOString(), taskId: request.taskId, status: "success" }) + "\\n");
`);

  const { events, result } = await collectEvents(
    new DevAgentAdapter(`${process.execPath} ${stubPath}`),
    createRequest("devagent"),
    workspacePath,
    artifactDir,
  );

  assert.equal(result.status, "success");
  assert.deepEqual(events.map((event) => event.type), ["started", "artifact", "completed"]);
});

test("DevAgentAdapter reports cancelled runs as cancelled", async () => {
  const { root, artifactDir, workspacePath } = await createWorkspace();
  const stubPath = join(root, "devagent-cancel-stub.js");
  await createStub(stubPath, `#!/usr/bin/env node
setTimeout(() => process.exit(0), 10000);
`);

  const events: TaskExecutionEvent[] = [];
  const handle = await new DevAgentAdapter(`${process.execPath} ${stubPath}`).launch(
    createRequest("devagent"),
    workspacePath,
    artifactDir,
    (event) => {
      events.push(event);
    },
  );

  await handle.cancel();
  const result = await handle.wait();

  assert.equal(result.status, "cancelled");
  assert.equal(result.error?.code, "CANCELLED");
  assert.equal(events.length, 0);
});

test("CodexAdapter smoke test with stub executable", async () => {
  const { root, artifactDir, workspacePath } = await createWorkspace();
  const stubPath = join(root, "codex-stub.js");
  await createStub(stubPath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const outIndex = args.indexOf("-o");
if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], "stub codex output\\n");
process.stdout.write("{\\"type\\":\\"result\\",\\"message\\":\\"ok\\"}\\n");
`);

  const { events, result } = await collectEvents(
    new CodexAdapter(`${process.execPath} ${stubPath}`),
    createRequest("codex"),
    workspacePath,
    artifactDir,
  );

  assert.equal(result.status, "success");
  assert.equal(events.at(-1)?.type, "completed");
  assert.match(await readFile(join(artifactDir, "triage-report.md"), "utf8"), /stub codex output/);
});

test("ClaudeAdapter smoke test with stub executable", async () => {
  const { root, artifactDir, workspacePath } = await createWorkspace();
  const stubPath = join(root, "claude-stub.js");
  await createStub(stubPath, `#!/usr/bin/env node
process.stdout.write("claude stub output\\n");
`);

  const { events, result } = await collectEvents(
    new ClaudeAdapter(`${process.execPath} ${stubPath}`),
    createRequest("claude"),
    workspacePath,
    artifactDir,
  );

  assert.equal(result.status, "success");
  assert.equal(events.at(-1)?.type, "completed");
});

test("OpenCodeAdapter smoke test with stub executable", async () => {
  const { root, artifactDir, workspacePath } = await createWorkspace();
  const stubPath = join(root, "opencode-stub.js");
  await createStub(stubPath, `#!/usr/bin/env node
process.stdout.write("opencode stub output\\n");
`);

  const { events, result } = await collectEvents(
    new OpenCodeAdapter(`${process.execPath} ${stubPath}`),
    createRequest("opencode"),
    workspacePath,
    artifactDir,
  );

  assert.equal(result.status, "success");
  assert.equal(events.at(-1)?.type, "completed");
});
