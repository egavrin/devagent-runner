import type {
  ExecutorSpec,
  TaskExecutionEvent,
  TaskExecutionRequest,
  TaskExecutionResult,
  WorkspaceSpec,
} from "@devagent-sdk/types";

export type RunStatus = "running" | "success" | "failed" | "cancelled";

export interface WorkspaceManager {
  prepare(spec: WorkspaceSpec): Promise<{ workspacePath: string }>;
  cleanup(workspacePath: string): Promise<void>;
}

export interface RunHandle {
  readonly id: string;
  readonly pid?: number;
  status(): RunStatus;
  wait(): Promise<TaskExecutionResult>;
  cancel(): Promise<void>;
}

export abstract class TrackedRunHandle implements RunHandle {
  private currentStatus: RunStatus = "running";

  constructor(
    readonly id: string,
    readonly pid: number | undefined,
    private readonly resultPromise: Promise<TaskExecutionResult>,
  ) {
    void this.resultPromise.then((result) => {
      this.currentStatus = result.status;
    }).catch(() => {
      this.currentStatus = "failed";
    });
  }

  status(): RunStatus {
    return this.currentStatus;
  }

  wait(): Promise<TaskExecutionResult> {
    return this.resultPromise;
  }

  protected markCancelled(): void {
    this.currentStatus = "cancelled";
  }

  abstract cancel(): Promise<void>;
}

export interface ExecutorAdapter {
  executorId(): string;
  canHandle(spec: ExecutorSpec): boolean;
  launch(
    request: TaskExecutionRequest,
    workspacePath: string,
    artifactDir: string,
    onEvent: (event: TaskExecutionEvent) => void,
  ): Promise<RunHandle>;
}

export type RunnerErrorCode =
  | "EXECUTOR_NOT_FOUND"
  | "INVALID_REQUEST"
  | "WORKSPACE_PREPARE_FAILED"
  | "PROCESS_LAUNCH_FAILED"
  | "EXECUTION_FAILED"
  | "ARTIFACT_COLLECTION_FAILED"
  | "CANCELLED";

export class RunnerError extends Error {
  constructor(
    readonly code: RunnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

export interface RunnerClient {
  startTask(request: TaskExecutionRequest): Promise<{ runId: string }>;
  subscribe(runId: string, onEvent: (event: TaskExecutionEvent) => void): Promise<void>;
  cancel(runId: string): Promise<void>;
  awaitResult(runId: string): Promise<TaskExecutionResult>;
}
