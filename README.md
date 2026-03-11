# DevAgent Runner

Local execution substrate for DevAgent workflow tasks.

## Maturity

Public alpha component. The repo is public, but the packages remain unpublished and are consumed
through local workspace dependencies during development.

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

## Command Resolution

The runner adapters resolve `codex`, `claude`, and `opencode` commands in this order:

1. adapter constructor override or resolver
2. runner env overrides
3. PATH defaults

Runner env overrides for the standalone CLI:

```bash
DEVAGENT_RUNNER_CODEX_BIN=/path/to/codex
DEVAGENT_RUNNER_CLAUDE_BIN=/path/to/claude
DEVAGENT_RUNNER_OPENCODE_BIN=/path/to/opencode
```

Default PATH command names are `codex`, `claude`, and `opencode`.

If the runner is embedded as a library, callers can pass either a fixed command string or a
request-aware resolver function to `CodexAdapter`, `ClaudeAdapter`, or `OpenCodeAdapter`.

## Local Development Wiring

For local MVP work this repo consumes `@devagent-sdk/*` through file dependencies from
`../devagent-sdk`. Downstream consumers can depend on `../devagent-runner/packages/*` during local
development.

Keep the runner repo self-contained: setup, validation, and support claims should be documented
here rather than delegated to a consumer repo.

## Validated Flow

The runner has been validated in the canonical path:

```text
TaskExecutionRequest -> LocalRunner -> DevAgentAdapter -> devagent execute
```

Adapter maturity today:

- `DevAgentAdapter`
  - live-validated and supported for the MVP path
- `CodexAdapter`
  - structured CLI integration with machine-readable event parsing
- `ClaudeAdapter`
  - structured CLI integration with streamed JSON event parsing
- `OpenCodeAdapter`
  - structured CLI integration with JSON event parsing

All non-DevAgent adapters now normalize machine-readable CLI output into the SDK event/result
model, write standard markdown artifacts, and rely on runner-side read-only enforcement for review
and verify stages. Support claims still depend on live validation evidence.

## Validation

Use the shared SDK fixture shape or a generated request JSON and validate each executor through the
debug CLI.

Examples:

```bash
devagent-runner run --request /tmp/codex-request.json
devagent-runner run --request /tmp/claude-request.json
DEVAGENT_RUNNER_OPENCODE_BIN=/Applications/OpenCode.app/Contents/MacOS/opencode-cli \
  devagent-runner run --request /tmp/opencode-request.json
```

The supported bar for promoting an executor path beyond experimental is:

- live CLI validation for `triage`, `plan`, `implement`, `verify`, `review`, and `repair`
- downstream integration validation through PR handoff
- cancellation and failure drills still passing

Current CLI smoke-validation snapshot as of 2026-03-11:

- `devagent`: `triage`, `verify`
- `codex`: `implement`, `review`
- `claude`: `plan`, `repair`
- `opencode`: `triage`, `plan`, `review`, `verify`

Those smoke passes confirm current CLI interoperability and artifact persistence. They do not by
themselves promote `codex`, `claude`, or `opencode` beyond experimental status.

## Limitations

- packages are not published to a registry yet
- the supported contributor path is the four-repo sibling checkout flow
- only executor paths with current live validation evidence should be described as supported

## Development

```bash
bun install
bun run typecheck
bun run test
bun run check:oss
```
