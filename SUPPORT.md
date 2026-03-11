# Support

## Usage questions

Open a GitHub issue with enough context to reproduce the runner or adapter behavior.

## Bug reports

Use the bug report template for workspace, eventing, cancellation, or adapter issues.

## Experimental vs supported

Supported:

- the DevAgent adapter path exercised through `devagent-runner -> devagent execute`

Experimental:

- `codex`, `claude`, and `opencode` adapters remain validation-gated until they have comparable
  live evidence through both `devagent-runner` CLI and at least one downstream integration
- runner CLI smoke passes alone are not enough to treat those adapters as supported

Binary overrides for standalone runner usage:

- `DEVAGENT_RUNNER_CODEX_BIN`
- `DEVAGENT_RUNNER_CLAUDE_BIN`
- `DEVAGENT_RUNNER_OPENCODE_BIN`
