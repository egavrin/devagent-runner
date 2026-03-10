# DevAgent Runner

Local execution substrate for DevAgent workflow tasks.

## Responsibilities

- prepare isolated workspaces
- launch executor adapters
- stream normalized SDK events
- persist run artifacts and event logs
- support cancellation and cleanup

## Packages

- `@devagent-runner/core`
  Shared runner interfaces and error model.
- `@devagent-runner/local-runner`
  Local runner implementation with filesystem-backed workspaces, artifacts, and event logs.
- `@devagent-runner/adapters`
  CLI adapters for `devagent`, `codex`, `claude`, and `opencode`.
- `@devagent-runner/cli`
  Debug CLI for local runs.

## Filesystem Layout

Runner state is created under the source repo:

```text
.devagent-runner/
  artifacts/<taskId>/
  events/<taskId>.jsonl
  runs/<runId>.json
  workspaces/<sanitized-work-branch>/
```

## CLI

```bash
devagent-runner run --request request.json
devagent-runner cancel <run-id>
devagent-runner inspect <run-id>
```

## Local Development Wiring

For local MVP work this repo consumes `@devagent-sdk/*` through file dependencies from
`../devagent-sdk`, and `devagent-hub` consumes this runner through file dependencies from
`../devagent-runner/packages/*`.

## Validated Flow

The runner has been validated in the canonical path:

```text
devagent-hub -> LocalRunnerClient -> LocalRunner -> DevAgentAdapter -> devagent execute
```

Stub smoke tests cover all four adapters, and live Hub validation has exercised the `DevAgentAdapter`
path against a real GitHub repository.

## Development

```bash
bun install
bun run typecheck
bun run test
```
