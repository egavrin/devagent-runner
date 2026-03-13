import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { ExecutorAdapter, RunHandle, RunStatus } from "@devagent-runner/core";
import { RunnerError, TrackedRunHandle } from "@devagent-runner/core";
import { validateTaskExecutionEvent, validateTaskExecutionResult } from "@devagent-sdk/validation";
import type {
  ArtifactKind,
  ArtifactRef,
  ExecutorSpec,
  TaskExecutionEvent,
  TaskExecutionRequest,
  TaskExecutionResult,
} from "@devagent-sdk/types";
import { PROTOCOL_VERSION } from "@devagent-sdk/types";

type CommandResolver = string | ((request: TaskExecutionRequest) => string | undefined);

type StructuredRunState = {
  readonly stdoutLines: string[];
  readonly finalTextParts: string[];
  readonly errors: string[];
};

type StructuredFinalizeResult = {
  body?: string;
  errorMessage?: string;
  status?: Exclude<RunStatus, "running">;
};

type StructuredAdapterContext = {
  request: TaskExecutionRequest;
  artifactDir: string;
  workspacePath: string;
  state: StructuredRunState;
  onEvent: (event: TaskExecutionEvent) => void;
};

type LaunchOptions = {
  env?: NodeJS.ProcessEnv;
};

function isEntireRequestReadOnly(request: TaskExecutionRequest): boolean {
  return request.execution.repositories.every((repository) => repository.readOnly);
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const character of command.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function envVarForExecutor(executorId: ExecutorSpec["executorId"]): string | undefined {
  switch (executorId) {
    case "codex":
      return "DEVAGENT_RUNNER_CODEX_BIN";
    case "claude":
      return "DEVAGENT_RUNNER_CLAUDE_BIN";
    case "opencode":
      return "DEVAGENT_RUNNER_OPENCODE_BIN";
    default:
      return undefined;
  }
}

function defaultCommandForExecutor(executorId: ExecutorSpec["executorId"]): string {
  switch (executorId) {
    case "devagent":
      return "devagent";
    case "codex":
      return "codex";
    case "claude":
      return "claude";
    case "opencode":
      return "opencode";
  }
}

function resolveCommand(
  executorId: ExecutorSpec["executorId"],
  resolver: CommandResolver | undefined,
  request: TaskExecutionRequest,
): string {
  const explicit = typeof resolver === "function" ? resolver(request) : resolver;
  if (explicit?.trim()) {
    return explicit.trim();
  }

  const envVar = envVarForExecutor(executorId);
  if (envVar && process.env[envVar]?.trim()) {
    return process.env[envVar]!.trim();
  }

  return defaultCommandForExecutor(executorId);
}

async function waitForFile(path: string, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await fileExists(path)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fileExists(path);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
}

function artifactTitle(taskType: TaskExecutionRequest["taskType"]): string {
  return taskType[0]!.toUpperCase() + taskType.slice(1);
}

class ProcessRunHandle extends TrackedRunHandle {
  constructor(
    readonly id: string,
    private readonly child: ChildProcess,
    resultPromise: Promise<TaskExecutionResult>,
  ) {
    super(id, child.pid ?? undefined, resultPromise);
  }

  async cancel(): Promise<void> {
    this.markCancelled();
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

function bulletList(items: string[] | undefined): string {
  const values = items?.map((item) => item.trim()).filter(Boolean) ?? [];
  if (values.length === 0) {
    return "";
  }
  return values.map((item) => `- ${item}`).join("\n");
}

function buildPrompt(request: TaskExecutionRequest): string {
  const readOnlyInstruction = isEntireRequestReadOnly(request)
    ? [
        "Workspace is read-only. Do not modify files.",
        "Prefer answering directly from the provided task context.",
        "Avoid subagents, todos, shell commands, and broad filesystem exploration unless strictly required to produce the final artifact body.",
        "If the task cannot be completed confidently without edits or extra investigation, state that clearly in the final artifact body.",
      ].join(" ")
    : "Workspace is writable. Edit files only when needed for the task.";

  const expectedArtifact = artifactKindForTask(request.taskType);
  const parts = [
    `Task type: ${request.taskType}`,
    `Expected artifact: ${expectedArtifact} (${artifactFileName(expectedArtifact)})`,
    `Issue: ${request.workItem.title ?? request.workItem.externalId}`,
    request.context.summary ? `Summary:\n${request.context.summary}` : "",
    request.context.issueBody ? `Issue body:\n${request.context.issueBody}` : "",
    request.context.comments?.length
      ? `Comments:\n${request.context.comments.map((comment) => `- ${comment.author ?? "unknown"}: ${comment.body}`).join("\n")}`
      : "",
    request.context.changedFilesHint?.length
      ? `Changed files hint:\n${bulletList(request.context.changedFilesHint)}`
      : "",
    request.context.skills?.length ? `Relevant skills:\n${bulletList(request.context.skills)}` : "",
    request.context.extraInstructions?.length
      ? `Extra instructions:\n${bulletList(request.context.extraInstructions)}`
      : "",
    request.constraints.verifyCommands?.length
      ? `Verification commands:\n${request.constraints.verifyCommands.map((command) => `- ${command}`).join("\n")}`
      : "",
    readOnlyInstruction,
    isEntireRequestReadOnly(request)
      ? "Do not use tools unless the final artifact would otherwise be impossible to produce."
      : "Use available tools and shell access as needed.",
    `Return only the ${expectedArtifact} body in Markdown with concise, operator-ready content. Do not wrap the response in code fences or add commentary outside the artifact body.`,
  ];

  return parts.filter(Boolean).join("\n\n");
}

async function createResult(
  request: TaskExecutionRequest,
  artifactDir: string,
  status: TaskExecutionResult["status"],
  startedAt: string,
  options: {
    body?: string;
    error?: TaskExecutionResult["error"];
  },
): Promise<TaskExecutionResult> {
  const artifacts: ArtifactRef[] = [];
  if (options.body?.trim()) {
    artifacts.push(await writeMarkdownArtifact(request, artifactDir, options.body));
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    taskId: request.taskId,
    status,
    artifacts,
    metrics: {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
    },
    error: options.error,
  };
}

async function createFallbackResult(
  request: TaskExecutionRequest,
  artifactDir: string,
  status: TaskExecutionResult["status"],
  startedAt: string,
  body: string,
  error?: TaskExecutionResult["error"],
): Promise<TaskExecutionResult> {
  return createResult(request, artifactDir, status, startedAt, { body, error });
}

function errorForStatus(
  status: RunStatus,
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

function emitProgress(
  request: TaskExecutionRequest,
  onEvent: (event: TaskExecutionEvent) => void,
  message: string,
): void {
  onEvent({
    protocolVersion: PROTOCOL_VERSION,
    type: "progress",
    at: new Date().toISOString(),
    taskId: request.taskId,
    message,
  });
}

function emitStdoutLog(
  request: TaskExecutionRequest,
  onEvent: (event: TaskExecutionEvent) => void,
  message: string,
): void {
  onEvent({
    protocolVersion: PROTOCOL_VERSION,
    type: "log",
    at: new Date().toISOString(),
    taskId: request.taskId,
    stream: "stdout",
    message,
  });
}

function appendFinalText(state: StructuredRunState, text: string | undefined): void {
  const value = text?.trim();
  if (!value) {
    return;
  }
  if (state.finalTextParts.at(-1) === value) {
    return;
  }
  state.finalTextParts.push(value);
}

function finalText(state: StructuredRunState): string | undefined {
  const combined = state.finalTextParts.join("\n\n").trim();
  return combined.length > 0 ? combined : undefined;
}

function extractClaudeText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const parts = value
    .filter((item): item is { type?: string; text?: string } => typeof item === "object" && item !== null)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text!.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function extractClaudePlanContent(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = value as {
    type?: string;
    filePath?: string;
    content?: string;
  };

  if (candidate.type !== "create" || typeof candidate.content !== "string") {
    return undefined;
  }

  if (!candidate.filePath?.includes("/.claude/plans/")) {
    return undefined;
  }

  return candidate.content.trim();
}

function extractCodexText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const parts = value
      .filter((item): item is { text?: string } => typeof item === "object" && item !== null)
      .map((item) => item.text?.trim() ?? "")
      .filter(Boolean);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
  if (typeof value === "object" && value !== null) {
    const candidate = value as { text?: string; content?: unknown };
    return extractCodexText(candidate.text ?? candidate.content);
  }
  return undefined;
}

function resolveOpenCodeModel(executor: ExecutorSpec): string | undefined {
  const model = executor.model?.trim();
  if (!model) {
    return undefined;
  }
  if (model.includes("/")) {
    return model;
  }

  const provider = executor.provider?.trim();
  if (!provider) {
    return undefined;
  }

  return `${provider}/${model}`;
}

abstract class StructuredCliAdapter implements ExecutorAdapter {
  constructor(
    private readonly id: ExecutorSpec["executorId"],
    private readonly commandResolver?: CommandResolver,
  ) {}

  executorId(): string {
    return this.id;
  }

  canHandle(spec: ExecutorSpec): boolean {
    return spec.executorId === this.id;
  }

  handlesFinalEvents(): boolean {
    return false;
  }

  protected abstract args(
    requestFile: string,
    artifactDir: string,
    workspacePath: string,
    prompt: string,
    executor: ExecutorSpec,
    request: TaskExecutionRequest,
  ): string[];

  protected abstract handleStdoutLine(line: string, context: StructuredAdapterContext): Promise<void> | void;

  protected launchOptions(_request: TaskExecutionRequest): LaunchOptions {
    return {};
  }

  private async processStdoutLine(line: string, context: StructuredAdapterContext): Promise<void> {
    try {
      await this.handleStdoutLine(line, context);
    } catch {
      emitStdoutLog(context.request, context.onEvent, line);
    }
  }

  protected async finalizeRun(_context: StructuredAdapterContext): Promise<StructuredFinalizeResult> {
    return {
      body: finalText(_context.state),
      errorMessage: _context.state.errors.join("\n").trim() || undefined,
    };
  }

  async launch(
    request: TaskExecutionRequest,
    workspacePath: string,
    repositoryPaths: Record<string, string>,
    artifactDir: string,
    onEvent: (event: TaskExecutionEvent) => void,
  ): Promise<RunHandle> {
    const startedAt = new Date().toISOString();
    const requestPath = join(artifactDir, "request.json");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(requestPath, JSON.stringify(request, null, 2));
    const prompt = buildPrompt(request);
    const command = resolveCommand(this.id, this.commandResolver, request);
    const commandParts = tokenizeCommand(command);
    const launchOptions = this.launchOptions(request);

    if (commandParts.length === 0) {
      throw new RunnerError("PROCESS_LAUNCH_FAILED", `No command resolved for executor ${this.id}`);
    }

    const child = spawn(
      commandParts[0]!,
      [
        ...commandParts.slice(1),
        ...this.args(requestPath, artifactDir, workspacePath, prompt, request.executor, request),
      ],
      {
        cwd: workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
        env: launchOptions.env ? { ...process.env, ...launchOptions.env } : process.env,
      },
    );
    const runId = randomUUID();
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    const state: StructuredRunState = {
      stdoutLines: [],
      finalTextParts: [],
      errors: [],
    };

    onEvent({
      protocolVersion: PROTOCOL_VERSION,
      type: "started",
      at: startedAt,
      taskId: request.taskId,
    });

    const context: StructuredAdapterContext = {
      request,
      artifactDir,
      workspacePath,
      state,
      onEvent,
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const message = chunk.toString();
      stdout += message;
      stdoutBuffer += message;

      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        state.stdoutLines.push(line);
        void this.processStdoutLine(line, context);
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
      });
    });

    const resultPromise = new Promise<TaskExecutionResult>((resolve, reject) => {
      child.once("error", (error: Error) => {
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
          const trailing = stdoutBuffer.trim();
          if (trailing) {
            state.stdoutLines.push(trailing);
            await this.processStdoutLine(trailing, context);
          }
          const finalized = await this.finalizeRun(context);
          const status: Exclude<RunStatus, "running"> = finalized.status
            ?? (exitSignal === "SIGTERM" ? "cancelled" : exitCode === 0 ? "success" : "failed");
          const errorMessage = finalized.errorMessage
            ?? state.errors.join("\n").trim()
            ?? stderr.trim()
            ?? finalText(state)
            ?? `Executor ${this.id} completed without output.`;
          const result = await createResult(
            request,
            artifactDir,
            status,
            startedAt,
            {
              body: finalized.body,
              error: errorForStatus(status, errorMessage),
            },
          );
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

  handlesFinalEvents(): boolean {
    return true;
  }

  async launch(
    request: TaskExecutionRequest,
    workspacePath: string,
    repositoryPaths: Record<string, string>,
    artifactDir: string,
    onEvent: (event: TaskExecutionEvent) => void,
  ): Promise<RunHandle> {
    const startedAt = new Date().toISOString();
    const requestPath = join(artifactDir, "request.json");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(requestPath, JSON.stringify(request, null, 2));
    const commandParts = tokenizeCommand(this.command);
    const primaryRepositoryPath =
      repositoryPaths[request.execution.primaryRepositoryId] ?? workspacePath;
    const child = spawn(
      commandParts[0]!,
      [...commandParts.slice(1), "execute", "--request", requestPath, "--artifact-dir", artifactDir],
      {
        cwd: primaryRepositoryPath,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const runId = randomUUID();
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter((line: string) => line.trim());
      for (const line of lines) {
        try {
          onEvent(validateTaskExecutionEvent(JSON.parse(line)));
        } catch {
          onEvent({
            protocolVersion: PROTOCOL_VERSION,
            type: "log",
            at: new Date().toISOString(),
            taskId: request.taskId,
            stream: "stdout",
            message: line,
          });
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
      });
    });

    const resultPromise = new Promise<TaskExecutionResult>((resolve, reject) => {
      child.once("error", (error: Error) => reject(new RunnerError("PROCESS_LAUNCH_FAILED", error.message)));
      let exitSignal: NodeJS.Signals | null = null;

      child.once("exit", (_code: number | null, signal: NodeJS.Signals | null) => {
        exitSignal = signal;
      });

      child.once("close", async () => {
        try {
          const resultPath = join(artifactDir, "result.json");
          if (!await waitForFile(resultPath)) {
            const status: RunStatus = exitSignal === "SIGTERM" ? "cancelled" : "failed";
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
            if (status === "failed") {
              onEvent({
                protocolVersion: PROTOCOL_VERSION,
                type: "log",
                at: new Date().toISOString(),
                taskId: request.taskId,
                stream: "stderr",
                message: stderr || "DevAgent did not emit result.json",
              });
              if (fallback.artifacts[0]) {
                onEvent({
                  protocolVersion: PROTOCOL_VERSION,
                  type: "artifact",
                  at: new Date().toISOString(),
                  taskId: request.taskId,
                  artifact: fallback.artifacts[0],
                });
              }
              onEvent({
                protocolVersion: PROTOCOL_VERSION,
                type: "completed",
                at: new Date().toISOString(),
                taskId: request.taskId,
                status,
              });
            }
            resolve(fallback);
            return;
          }
          const parsed = validateTaskExecutionResult(JSON.parse(await readFile(resultPath, "utf-8")));
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });

    return new ProcessRunHandle(runId, child, resultPromise);
  }
}

export class CodexAdapter extends StructuredCliAdapter {
  constructor(command?: CommandResolver) {
    super("codex", command);
  }

  protected args(
    _requestFile: string,
    artifactDir: string,
    workspacePath: string,
    prompt: string,
    executor: ExecutorSpec,
    request: TaskExecutionRequest,
  ): string[] {
    return [
      "exec",
      "--skip-git-repo-check",
      "--json",
      "-C",
      workspacePath,
      "-o",
      join(artifactDir, "last-message.txt"),
      "-m",
      executor.model ?? "gpt-5-codex",
      "-s",
      isEntireRequestReadOnly(request) ? "read-only" : "workspace-write",
      prompt,
    ];
  }

  protected handleStdoutLine(line: string, context: StructuredAdapterContext): void {
    const parsed = JSON.parse(line) as {
      type?: string;
      item?: { type?: string; text?: string; content?: unknown };
    };
    switch (parsed.type) {
      case "thread.started":
        emitProgress(context.request, context.onEvent, "Codex thread started");
        return;
      case "turn.started":
        emitProgress(context.request, context.onEvent, "Codex turn started");
        return;
      case "item.completed":
        appendFinalText(context.state, extractCodexText(parsed.item));
        emitProgress(
          context.request,
          context.onEvent,
          `Codex item completed: ${parsed.item?.type ?? "unknown"}`,
        );
        return;
      case "turn.completed":
        emitProgress(context.request, context.onEvent, "Codex turn completed");
        return;
      default:
        emitStdoutLog(context.request, context.onEvent, line);
    }
  }

  protected override async finalizeRun(context: StructuredAdapterContext): Promise<StructuredFinalizeResult> {
    const lastMessagePath = join(context.artifactDir, "last-message.txt");
    if (await fileExists(lastMessagePath)) {
      appendFinalText(context.state, await readFile(lastMessagePath, "utf-8"));
    }

    const body = finalText(context.state);
    if (!body) {
      return {
        status: "failed",
        errorMessage: "Codex did not produce a final assistant message.",
      };
    }
    return {
      body,
      errorMessage: context.state.errors.join("\n").trim() || undefined,
    };
  }
}

export class ClaudeAdapter extends StructuredCliAdapter {
  constructor(command?: CommandResolver) {
    super("claude", command);
  }

  protected args(
    _requestFile: string,
    _artifactDir: string,
    _workspacePath: string,
    prompt: string,
    executor: ExecutorSpec,
    request: TaskExecutionRequest,
  ): string[] {
    return [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      isEntireRequestReadOnly(request) ? "plan" : "bypassPermissions",
      "--model",
      executor.model ?? "sonnet",
      prompt,
    ];
  }

  protected handleStdoutLine(line: string, context: StructuredAdapterContext): void {
    const parsed = JSON.parse(line) as {
      type?: string;
      subtype?: string;
      message?: { content?: unknown };
      result?: string;
      is_error?: boolean;
      error?: { message?: string };
      tool_use_result?: unknown;
    };

    switch (parsed.type) {
      case "assistant":
        appendFinalText(context.state, extractClaudeText(parsed.message?.content));
        emitProgress(context.request, context.onEvent, "Claude assistant response received");
        return;
      case "user":
        appendFinalText(context.state, extractClaudePlanContent(parsed.tool_use_result));
        return;
      case "result":
        if (parsed.is_error) {
          context.state.errors.push(parsed.result?.trim() || "Claude returned an error.");
        }
        appendFinalText(context.state, parsed.result);
        emitProgress(
          context.request,
          context.onEvent,
          `Claude result: ${parsed.subtype ?? (parsed.is_error ? "error" : "success")}`,
        );
        return;
      case "system":
      case "rate_limit_event":
        return;
      default:
        if (parsed.error?.message) {
          context.state.errors.push(parsed.error.message);
          return;
        }
        emitStdoutLog(context.request, context.onEvent, line);
    }
  }

  protected override async finalizeRun(context: StructuredAdapterContext): Promise<StructuredFinalizeResult> {
    const body = finalText(context.state);
    if (!body) {
      return {
        status: "failed",
        errorMessage: "Claude did not produce a final assistant message.",
      };
    }

    return {
      body,
      errorMessage: context.state.errors.join("\n").trim() || undefined,
    };
  }
}

export class OpenCodeAdapter extends StructuredCliAdapter {
  constructor(command?: CommandResolver) {
    super("opencode", command);
  }

  protected args(
    _requestFile: string,
    _artifactDir: string,
    _workspacePath: string,
    prompt: string,
    executor: ExecutorSpec,
    request: TaskExecutionRequest,
  ): string[] {
    const args = [
      "run",
      "--format",
      "json",
      "--agent",
      "build",
      prompt,
    ];

    const model = resolveOpenCodeModel(executor);
    if (model) {
      args.splice(args.length - 1, 0, "--model", model);
    }

    return args;
  }

  protected override launchOptions(request: TaskExecutionRequest): LaunchOptions {
    if (!isEntireRequestReadOnly(request)) {
      return {};
    }

    return {
      env: {
        OPENCODE_PERMISSION: JSON.stringify({
          "*": "deny",
          read: "allow",
          list: "allow",
          edit: "deny",
          write: "deny",
          todowrite: "deny",
          todoread: "deny",
          task: "deny",
          bash: "deny",
          glob: "deny",
          grep: "deny",
          webfetch: "deny",
          websearch: "deny",
          codesearch: "deny",
          question: "deny",
        }),
      },
    };
  }

  protected handleStdoutLine(line: string, context: StructuredAdapterContext): void {
    const parsed = JSON.parse(line) as {
      type?: string;
      error?: { message?: string; data?: { message?: string } };
      part?: { tool?: string; text?: string };
    };
    const errorMessage = parsed.error?.message?.trim() || parsed.error?.data?.message?.trim();

    switch (parsed.type) {
      case "step_start":
        emitProgress(context.request, context.onEvent, "OpenCode step started");
        return;
      case "step_finish":
        emitProgress(context.request, context.onEvent, "OpenCode step finished");
        return;
      case "tool_use":
        emitProgress(
          context.request,
          context.onEvent,
          `OpenCode tool completed: ${parsed.part?.tool ?? "unknown"}`,
        );
        return;
      case "text":
        appendFinalText(context.state, parsed.part?.text);
        emitProgress(context.request, context.onEvent, "OpenCode assistant response received");
        return;
      case "reasoning":
        return;
      case "error":
        context.state.errors.push(errorMessage || "OpenCode returned an error.");
        return;
      case "permission_asked":
        context.state.errors.push(errorMessage || "OpenCode requested permission.");
        return;
      default:
        emitStdoutLog(context.request, context.onEvent, line);
    }
  }

  protected override async finalizeRun(context: StructuredAdapterContext): Promise<StructuredFinalizeResult> {
    const body = finalText(context.state);
    if (!body) {
      return {
        status: "failed",
        errorMessage: context.state.errors.join("\n").trim() || "OpenCode did not produce a final assistant message.",
      };
    }

    return {
      body,
      errorMessage: context.state.errors.join("\n").trim() || undefined,
    };
  }
}
