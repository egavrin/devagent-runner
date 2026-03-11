# DevAgent Runner Workflow

## How work enters this repo

Most changes begin as one of:

- workspace lifecycle fixes
- adapter/runtime behavior fixes
- event/result normalization improvements
- runner CLI and inspection improvements

## Expected implementation path

1. Keep the SDK contract stable.
2. Fix the local runner and DevAgent adapter path first.
3. Add or update tests for lifecycle behavior.
4. Update docs if the operator or contributor story changes.

## Required checks before merge

```bash
bun install
bun run typecheck
bun run test
bun run check:oss
```

## Done means

- the DevAgent adapter path still works through Hub baseline smoke
- artifacts and events are written predictably
- cancellation, timeout, and cleanup behavior remain test-covered
- docs do not overstate experimental adapter maturity

## Supported vs experimental

- Supported: `DevAgentAdapter` in the current Hub -> Runner -> DevAgent path
- Experimental: `CodexAdapter`, `ClaudeAdapter`, and `OpenCodeAdapter` until they have matching live validation
