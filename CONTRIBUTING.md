# Contributing to DevAgent Runner

## Who this repo is for

Contributors working on workspace isolation, executor adapters, normalized events, artifacts, and
local execution behavior for the DevAgent stack.

## Prerequisites

- Bun `1.3.10+`
- Node `20+`
- the four sibling repos checked out side by side

For the supported setup path, start from [`devagent-hub`](../devagent-hub/README.md):

```bash
cd ../devagent-hub
bun install
bun run bootstrap:local
```

## Local checks before opening a PR

```bash
bun install
bun run typecheck
bun run test
bun run check:oss
```

If your change affects the live path, also run the Hub baseline checks from `../devagent-hub`.

## Contribution rules

- Keep the DevAgent path stable first.
- Treat other adapters as experimental unless live validation proves parity.
- Keep PRs small and lifecycle-focused.
- Update docs if you change setup, adapter maturity, or validation claims.
