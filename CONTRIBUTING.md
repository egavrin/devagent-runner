# Contributing to DevAgent Runner

## Who this repo is for

Contributors working on workspace isolation, executor adapters, normalized events, artifacts, and
local execution behavior for the DevAgent stack.

## Prerequisites

- Bun `1.3.10+`
- Node `20+`
- the four sibling repos checked out side by side

For local development, bootstrap the sibling repos directly:

```bash
cd ../devagent-sdk && bun install
cd ../devagent-runner && bun install
```

## Local checks before opening a PR

```bash
bun install
bun run typecheck
bun run test
bun run check:oss
```

If your change affects a downstream integration path, run that consumer's baseline checks in
addition to the runner checks above.

## Contribution rules

- Keep the DevAgent path stable first.
- Treat other adapters as experimental unless live validation proves parity.
- Keep non-DevAgent adapter command resolution aligned with adapter constructor overrides and runner
  env overrides.
- Keep PRs small and lifecycle-focused.
- Update docs if you change setup, adapter maturity, or validation claims.
