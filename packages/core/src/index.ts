import type {
  ExecutorSpec,
  RepositoryWorkspaceSpec,
  TaskExecutionEvent,
  TaskExecutionRequest,
  TaskExecutionResult,
  WorkspaceSpec,
} from "@devagent-sdk/types";

export type RunStatus = "running" | "success" | "failed" | "cancelled";

export interface WorkspaceManager {
  prepare(spec: WorkspaceSpec): Promise<{
    workspacePath: string;
    repositoryPaths: Record<string, string>;
  }>;
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
  handlesFinalEvents?(): boolean;
  launch(
    request: TaskExecutionRequest,
    workspacePath: string,
    repositoryPaths: Record<string, string>,
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

export function primaryRepositorySpec(spec: WorkspaceSpec): RepositoryWorkspaceSpec {
  const primary = spec.repositories.find((repository) => repository.repositoryId === spec.primaryRepositoryId);
  if (!primary) {
    throw new RunnerError(
      "INVALID_REQUEST",
      `Workspace primaryRepositoryId ${spec.primaryRepositoryId} does not match any repository execution spec.`,
    );
  }
  return primary;
}
