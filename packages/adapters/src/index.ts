import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { ExecutorAdapter, RunHandle } from "@devagent-runner/core";
import { RunnerError } from "@devagent-runner/core";
import type {
  ArtifactKind,
  ArtifactRef,
  ExecutorSpec,
  TaskExecutionEvent,
  TaskExecutionRequest,
  TaskExecutionResult,
} from "@devagent-sdk/types";
import { PROTOCOL_VERSION } from "@devagent-sdk/types";

async function waitForFile(path: string, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (existsSync(path)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return existsSync(path);
}

function artifactFileName(kind: ArtifactKind): string {
  switch (kind) {
    case "triage-report":
      return "triage-report.md";
    case "plan":
      return "plan.md";
    case "implementation-summary":
      return "implementation-summary.md";
    case "verification-report":
      return "verification-report.md";
    case "review-report":
      return "review-report.md";
    case "final-summary":
      return "final-summary.md";
  }
  throw new Error("Unsupported artifact kind");
}

function artifactKindForTask(taskType: TaskExecutionRequest["taskType"]): ArtifactKind {
  switch (taskType) {
    case "triage":
      return "triage-report";
    case "plan":
      return "plan";
    case "implement":
      return "implementation-summary";
    case "verify":
      return "verification-report";
    case "review":
      return "review-report";
    case "repair":
      return "final-summary";
  }
  throw new Error("Unsupported task type");
}

function artifactTitle(taskType: TaskExecutionRequest["taskType"]): string {
  return taskType[0]!.toUpperCase() + taskType.slice(1);
}

class ProcessRunHandle implements RunHandle {
  private currentStatus: "running" | "success" | "failed" | "cancelled" = "running";
  readonly pid: number | undefined;

  constructor(
    readonly id: string,
    private readonly child: ChildProcess,
    private readonly resultPromise: Promise<TaskExecutionResult>,
  ) {
    this.pid = child.pid ?? undefined;
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

  async cancel(): Promise<void> {
    this.currentStatus = "cancelled";
    this.child.kill("SIGTERM");
  }
}

async function writeMarkdownArtifact(
  request: TaskExecutionRequest,
  artifactDir: string,
  body: string,
): Promise<ArtifactRef> {
  const kind = artifactKindForTask(request.taskType);
  const path = join(artifactDir, artifactFileName(kind));
  await writeFile(path, `# ${artifactTitle(request.taskType)}\n\n${body.trim()}\n`);
  return {
    kind,
    path,
    mimeType: "text/markdown",
    createdAt: new Date().toISOString(),
  };
}

function buildPrompt(request: TaskExecutionRequest): string {
  const instructions = request.context.extraInstructions?.join("\n") ?? "";
  const comments =
    request.context.comments
      ?.map((comment: { author?: string; body: string }) => `- ${comment.author ?? "unknown"}: ${comment.body}`)
      .join("\n") ?? "";
  return [
    `Task type: ${request.taskType}`,
    `Issue: ${request.workItem.title ?? request.workItem.externalId}`,
    request.context.summary ?? "",
    request.context.issueBody ?? "",
    comments ? `Comments:\n${comments}` : "",
    instructions,
    "Respond with concise plain text only.",
  ].filter(Boolean).join("\n\n");
}

async function createFallbackResult(
  request: TaskExecutionRequest,
  artifactDir: string,
  status: TaskExecutionResult["status"],
  startedAt: string,
  body: string,
  error?: TaskExecutionResult["error"],
): Promise<TaskExecutionResult> {
  const artifact = await writeMarkdownArtifact(request, artifactDir, body);
  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: request.taskId,
    status,
    artifacts: [artifact],
    metrics: {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
    },
    error,
  };
}

function errorForStatus(
  status: TaskExecutionResult["status"],
  message: string,
): TaskExecutionResult["error"] | undefined {
  if (status === "success") {
    return undefined;
  }
  if (status === "cancelled") {
    return {
      code: "CANCELLED",
      message,
    };
  }
  return {
    code: "EXECUTION_FAILED",
    message,
  };
}

type CliAdapterConfig = {
  command: string;
  args: (requestFile: string, artifactDir: string, workspacePath: string, prompt: string, executor: ExecutorSpec) => string[];
  parseOutput?: (stdout: string, artifactDir: string) => Promise<string>;
};

class CliPromptAdapter implements ExecutorAdapter {
  constructor(
    private readonly id: ExecutorSpec["executorId"],
    private readonly config: CliAdapterConfig,
  ) {}

  executorId(): string {
    return this.id;
  }

  canHandle(spec: ExecutorSpec): boolean {
    return spec.executorId === this.id;
  }

  async launch(
    request: TaskExecutionRequest,
    workspacePath: string,
    artifactDir: string,
    onEvent: (event: TaskExecutionEvent) => void,
  ): Promise<RunHandle> {
    const startedAt = new Date().toISOString();
    const requestPath = join(artifactDir, "request.json");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(requestPath, JSON.stringify(request, null, 2));
    const prompt = buildPrompt(request);
    const child = spawn(
      this.config.command.split(/\s+/)[0]!,
      [
        ...this.config.command.split(/\s+/).slice(1),
        ...this.config.args(requestPath, artifactDir, workspacePath, prompt, request.executor),
      ],
      { cwd: workspacePath, stdio: ["ignore", "pipe", "pipe"] },
    );
    const runId = randomUUID();
    let stdout = "";
    let stderr = "";

    onEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: "started",
      at: startedAt,
      taskId: request.taskId,
    } as TaskExecutionEvent);

    child.stdout.on("data", (chunk: Buffer) => {
      const message = chunk.toString();
      stdout += message;
      onEvent({
        protocolVersion: PROTOCOL_VERSION,
        type: "log",
        at: new Date().toISOString(),
        taskId: request.taskId,
        stream: "stdout",
        message,
      } as TaskExecutionEvent);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString();
      stderr += message;
      onEvent({
        protocolVersion: PROTOCOL_VERSION,
        type: "log",
        at: new Date().toISOString(),
        taskId: request.taskId,
        stream: "stderr",
        message,
      } as TaskExecutionEvent);
    });

    const resultPromise = new Promise<TaskExecutionResult>((resolve, reject) => {
      child.once("error", async (error: Error) => {
        reject(new RunnerError("PROCESS_LAUNCH_FAILED", error.message));
      });

      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;

      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        exitCode = code;
        exitSignal = signal;
      });

      child.once("close", async () => {
        try {
          const body = this.config.parseOutput
            ? await this.config.parseOutput(stdout, artifactDir)
            : stdout || stderr || `Executor ${this.id} completed without output.`;
          const status = exitSignal === "SIGTERM" ? "cancelled" : exitCode === 0 ? "success" : "failed";
          const result = await createFallbackResult(
            request,
            artifactDir,
            status,
            startedAt,
            body,
            errorForStatus(status, stderr || body),
          );
          onEvent({
            protocolVersion: PROTOCOL_VERSION,
            type: "artifact",
            at: new Date().toISOString(),
            taskId: request.taskId,
            artifact: result.artifacts[0]!,
          } as TaskExecutionEvent);
          onEvent({
            protocolVersion: PROTOCOL_VERSION,
            type: "completed",
            at: new Date().toISOString(),
            taskId: request.taskId,
            status,
          } as TaskExecutionEvent);
          await writeFile(join(artifactDir, "result.json"), JSON.stringify(result, null, 2));
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });

    return new ProcessRunHandle(runId, child, resultPromise);
  }
}

export class DevAgentAdapter implements ExecutorAdapter {
  constructor(private readonly command = "devagent") {}

  executorId(): string {
    return "devagent";
  }

  canHandle(spec: ExecutorSpec): boolean {
    return spec.executorId === "devagent";
  }

  async launch(
    request: TaskExecutionRequest,
    workspacePath: string,
    artifactDir: string,
    onEvent: (event: TaskExecutionEvent) => void,
  ): Promise<RunHandle> {
    const startedAt = new Date().toISOString();
    const requestPath = join(artifactDir, "request.json");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(requestPath, JSON.stringify(request, null, 2));
    const commandParts = this.command.split(/\s+/);
    const child = spawn(commandParts[0]!, [...commandParts.slice(1), "execute", "--request", requestPath, "--artifact-dir", artifactDir], {
      cwd: workspacePath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const runId = randomUUID();
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter((line: string) => line.trim());
      for (const line of lines) {
        try {
          onEvent(JSON.parse(line) as TaskExecutionEvent);
        } catch {
          onEvent({
            protocolVersion: PROTOCOL_VERSION,
            type: "log",
            at: new Date().toISOString(),
            taskId: request.taskId,
            stream: "stdout",
            message: line,
          } as TaskExecutionEvent);
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString();
      stderr += message;
      onEvent({
        protocolVersion: PROTOCOL_VERSION,
        type: "log",
        at: new Date().toISOString(),
        taskId: request.taskId,
        stream: "stderr",
        message,
      } as TaskExecutionEvent);
    });

    const resultPromise = new Promise<TaskExecutionResult>((resolve, reject) => {
      child.once("error", (error: Error) => reject(new RunnerError("PROCESS_LAUNCH_FAILED", error.message)));
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;

      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        exitCode = code;
        exitSignal = signal;
      });

      child.once("close", async () => {
        try {
          const resultPath = join(artifactDir, "result.json");
          if (!await waitForFile(resultPath)) {
            const status = exitSignal === "SIGTERM" ? "cancelled" : "failed";
            const fallback = await createFallbackResult(
              request,
              artifactDir,
              status,
              startedAt,
              stderr || "DevAgent did not emit a result file.",
              errorForStatus(
                status,
                exitSignal === "SIGTERM" ? "Cancelled by operator" : (stderr || "Missing result.json"),
              ),
            );
            resolve(fallback);
            return;
          }
          const parsed = JSON.parse(await readFile(resultPath, "utf-8")) as TaskExecutionResult;
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });

    return new ProcessRunHandle(runId, child, resultPromise);
  }
}

export class CodexAdapter extends CliPromptAdapter {
  constructor(command = "codex") {
    super("codex", {
      command,
      args: (_requestFile, artifactDir, workspacePath, prompt, executor) => [
        "exec",
        "--skip-git-repo-check",
        "--json",
        "-C",
        workspacePath,
        "-o",
        join(artifactDir, "last-message.txt"),
        "-m",
        executor.model ?? "gpt-5-codex",
        prompt,
      ],
      parseOutput: async (stdout, artifactDir) => {
        const lastMessagePath = join(artifactDir, "last-message.txt");
        if (existsSync(lastMessagePath)) {
          return readFile(lastMessagePath, "utf-8");
        }
        return stdout;
      },
    });
  }
}

export class ClaudeAdapter extends CliPromptAdapter {
  constructor(command = "claude") {
    super("claude", {
      command,
      args: (_requestFile, _artifactDir, _workspacePath, prompt, executor) => [
        "-p",
        "--output-format",
        "json",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        executor.model ?? "sonnet",
        prompt,
      ],
      parseOutput: async (stdout) => stdout,
    });
  }
}

export class OpenCodeAdapter extends CliPromptAdapter {
  constructor(command = "opencode") {
    super("opencode", {
      command,
      args: (_requestFile, _artifactDir, _workspacePath, prompt, executor) => [
        "run",
        prompt,
        "--model",
        executor.model ?? "deepseek-chat",
        "--format",
        "json",
      ],
      parseOutput: async (stdout) => stdout,
    });
  }
}
