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

Example:

```bash
cp ../devagent-sdk/fixtures/request-plan.json /tmp/request-plan.json
devagent-runner run --request /tmp/request-plan.json
devagent-runner inspect <run-id>
```

## Local Development Wiring

For local MVP work this repo consumes `@devagent-sdk/*` through file dependencies from
`../devagent-sdk`, and `devagent-hub` consumes this runner through file dependencies from
`../devagent-runner/packages/*`.

The supported local setup path is the bootstrap flow documented in
[`devagent-hub/README.md`](../devagent-hub/README.md) and
[`devagent-hub/BASELINE_VALIDATION.md`](../devagent-hub/BASELINE_VALIDATION.md).

## Validated Flow

The runner has been validated in the canonical path:

```text
devagent-hub -> LocalRunnerClient -> LocalRunner -> DevAgentAdapter -> devagent execute
```

Adapter maturity today:

- `DevAgentAdapter`
  - live-validated and supported for the MVP path
- `CodexAdapter`
- `ClaudeAdapter`
- `OpenCodeAdapter`
  - adapter-present and smoke-tested, but still experimental

Treat the experimental adapters as development surfaces, not production-equivalent executor paths.

## Development

```bash
bun install
bun run typecheck
bun run test
```
