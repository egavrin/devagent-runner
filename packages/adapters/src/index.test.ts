import assert from "node:assert/strict";
import { join } from "node:path";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, test } from "vitest";
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

function createRequest(
  executorId: TaskExecutionRequest["executor"]["executorId"],
  options: { model?: string; provider?: string; readOnly?: boolean } = {},
): TaskExecutionRequest {
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
      readOnly: options.readOnly,
    },
    executor: {
      executorId,
      model: options.model ?? "test-model",
      provider: options.provider,
    },
    constraints: {},
    context: { summary: "smoke" },
    expectedArtifacts: ["triage-report"],
  };
}

afterEach(() => {
  delete process.env.DEVAGENT_RUNNER_CODEX_BIN;
});

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

test("DevAgentAdapter waits for close before reading result", async () => {
  const { root, artifactDir, workspacePath } = await createWorkspace();
  const stubPath = join(root, "devagent-close-stub.js");
  await createStub(stubPath, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const requestPath = args[args.indexOf("--request") + 1];
const artifactDir = args[args.indexOf("--artifact-dir") + 1];
const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
const artifactPath = path.join(artifactDir, "triage-report.md");
const resultPath = path.join(artifactDir, "result.json");
process.on("beforeExit", () => {
  fs.writeFileSync(artifactPath, "# Triage\\n\\nLate output\\n");
  fs.writeFileSync(resultPath, JSON.stringify({
    protocolVersion: "0.1",
    taskId: request.taskId,
    status: "success",
    artifacts: [{ kind: "triage-report", path: artifactPath, createdAt: new Date().toISOString() }],
    metrics: { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1 }
  }, null, 2));
  process.stdout.write(JSON.stringify({ protocolVersion: "0.1", type: "started", at: new Date().toISOString(), taskId: request.taskId }) + "\\n");
  process.stdout.write(JSON.stringify({ protocolVersion: "0.1", type: "artifact", at: new Date().toISOString(), taskId: request.taskId, artifact: { kind: "triage-report", path: artifactPath, createdAt: new Date().toISOString() } }) + "\\n");
  process.stdout.write(JSON.stringify({ protocolVersion: "0.1", type: "completed", at: new Date().toISOString(), taskId: request.taskId, status: "success" }) + "\\n");
});
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

test("DevAgentAdapter emits failure events when result.json is missing", async () => {
  const { root, artifactDir, workspacePath } = await createWorkspace();
  const stubPath = join(root, "devagent-missing-result-stub.js");
  await createStub(stubPath, `#!/usr/bin/env node
process.stderr.write("result file was never written\\n");
process.exit(1);
`);

  const { events, result } = await collectEvents(
    new DevAgentAdapter(`${process.execPath} ${stubPath}`),
    createRequest("devagent"),
    workspacePath,
    artifactDir,
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "EXECUTION_FAILED");
  assert.deepEqual(events.map((event) => event.type), ["log", "log", "artifact", "completed"]);
  assert.equal(events[0]?.type, "log");
  assert.match(events[0]?.type === "log" ? events[0].message : "", /result file was never written/);
});

test("CodexAdapter smoke test with stub executable", async () => {
  const { root, artifactDir, workspacePath } = await createWorkspace();
  const stubPath = join(root, "codex-stub.js");
  await createStub(stubPath, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const outIndex = args.indexOf("-o");
if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], "stub codex output\\n");
process.stdout.write("{\\"type\\":\\"thread.started\\"}\\n");
process.stdout.write("{\\"type\\":\\"turn.started\\"}\\n");
process.stdout.write("{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"stub codex output\\"}}\\n");
process.stdout.write("{\\"type\\":\\"turn.completed\\"}\\n");
`);

  process.env.DEVAGENT_RUNNER_CODEX_BIN = `${process.execPath} ${stubPath}`;
  const { events, result } = await collectEvents(
    new CodexAdapter(),
    createRequest("codex"),
    workspacePath,
    artifactDir,
  );

  assert.equal(result.status, "success");
  assert.deepEqual(events.map((event) => event.type), ["started", "progress", "progress", "progress", "progress"]);
  assert.match(await readFile(join(artifactDir, "triage-report.md"), "utf8"), /stub codex output/);
});

test("ClaudeAdapter smoke test with stub executable", async () => {
  const { root, artifactDir, workspacePath } = await createWorkspace();
  const stubPath = join(root, "claude-stub.js");
  await createStub(stubPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "claude stub output" }] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "claude stub output" }) + "\\n");
`);

  const { events, result } = await collectEvents(
    new ClaudeAdapter(`${process.execPath} ${stubPath}`),
    createRequest("claude"),
    workspacePath,
    artifactDir,
  );

  assert.equal(result.status, "success");
  assert.deepEqual(events.map((event) => event.type), ["started", "progress", "progress"]);
  assert.match(await readFile(join(artifactDir, "triage-report.md"), "utf8"), /claude stub output/);
});

test("OpenCodeAdapter smoke test with stub executable", async () => {
  const { root, artifactDir, workspacePath } = await createWorkspace();
  const stubPath = join(root, "opencode-stub.js");
  await createStub(stubPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
const agentIndex = args.indexOf("--agent");
if (agentIndex === -1 || args[agentIndex + 1] !== "build") {
  throw new Error("expected build agent");
}
const permissions = process.env.OPENCODE_PERMISSION || "";
if (!permissions.includes('"*":"deny"') || !permissions.includes('"read":"allow"') || !permissions.includes('"edit":"deny"') || !permissions.includes('"write":"deny"')) {
  throw new Error("expected read-only permissions");
}
if (process.argv.includes("--model")) {
  throw new Error("unexpected --model flag");
}
process.stdout.write(JSON.stringify({ type: "step_start", part: { type: "step-start" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: "opencode stub output" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "step_finish", part: { type: "step-finish" } }) + "\\n");
`);

  const { events, result } = await collectEvents(
    new OpenCodeAdapter(`${process.execPath} ${stubPath}`),
    createRequest("opencode", { readOnly: true }),
    workspacePath,
    artifactDir,
  );

  assert.equal(result.status, "success");
  assert.deepEqual(events.map((event) => event.type), ["started", "progress", "progress", "progress"]);
  assert.match(await readFile(join(artifactDir, "triage-report.md"), "utf8"), /opencode stub output/);
});

test("OpenCodeAdapter passes provider-qualified model names through", async () => {
  const { root, artifactDir, workspacePath } = await createWorkspace();
  const stubPath = join(root, "opencode-model-stub.js");
  await createStub(stubPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
const modelIndex = args.indexOf("--model");
if (modelIndex === -1 || args[modelIndex + 1] !== "opencode/big-pickle") {
  throw new Error("expected provider-qualified --model");
}
process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text: "opencode model output" } }) + "\\n");
`);

  const { result } = await collectEvents(
    new OpenCodeAdapter(`${process.execPath} ${stubPath}`),
    createRequest("opencode", { provider: "opencode", model: "big-pickle" }),
    workspacePath,
    artifactDir,
  );

  assert.equal(result.status, "success");
  assert.match(await readFile(join(artifactDir, "triage-report.md"), "utf8"), /opencode model output/);
});

test("OpenCodeAdapter surfaces structured errors without mislabeling them as permissions", async () => {
  const { root, artifactDir, workspacePath } = await createWorkspace();
  const stubPath = join(root, "opencode-error-stub.js");
  await createStub(stubPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "error",
  error: { data: { message: "Model not found: opencode/missing-model" } }
}) + "\\n");
process.exit(1);
`);

  const { result } = await collectEvents(
    new OpenCodeAdapter(`${process.execPath} ${stubPath}`),
    createRequest("opencode"),
    workspacePath,
    artifactDir,
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error?.message, "Model not found: opencode/missing-model");
});

test("ClaudeAdapter fails when no final assistant text is produced", async () => {
  const { root, artifactDir, workspacePath } = await createWorkspace();
  const stubPath = join(root, "claude-empty-stub.js");
  await createStub(stubPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "" }) + "\\n");
`);

  const { result } = await collectEvents(
    new ClaudeAdapter(`${process.execPath} ${stubPath}`),
    createRequest("claude"),
    workspacePath,
    artifactDir,
  );

  assert.equal(result.status, "failed");
  assert.equal(result.artifacts.length, 0);
});

test("ClaudeAdapter captures plan-mode file output when no final assistant text is emitted", async () => {
  const { root, artifactDir, workspacePath } = await createWorkspace();
  const stubPath = join(root, "claude-plan-stub.js");
  await createStub(stubPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "user",
  tool_use_result: {
    type: "create",
    filePath: "/Users/test/.claude/plans/example-plan.md",
    content: "# Example Plan\\n\\nExecutor claude handled task type plan."
  }
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "" }) + "\\n");
`);

  const { result } = await collectEvents(
    new ClaudeAdapter(`${process.execPath} ${stubPath}`),
    createRequest("claude", { readOnly: true }),
    workspacePath,
    artifactDir,
  );

  assert.equal(result.status, "success");
  assert.match(await readFile(join(artifactDir, "triage-report.md"), "utf8"), /Example Plan/);
});
