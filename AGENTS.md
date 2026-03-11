# DevAgent Runner Agent Guide

## Purpose

`devagent-runner` is the local execution substrate for the DevAgent stack. It owns workspace
preparation, adapter launch, normalized events, artifacts, cancellation, and cleanup.

## Rules

1. Keep Hub unaware of executor CLI details.
2. Treat the DevAgent adapter as the only production-grade path.
3. Do not claim parity for `codex`, `claude`, or `opencode` without live validation evidence.
4. Keep SDK request/event/result handling aligned with `devagent-sdk`.
5. Run `bun run typecheck`, `bun run test`, and `bun run check:oss` before finishing.

## Review focus

- workspace lifecycle
- event ordering
- cancellation and timeouts
- cleanup guarantees
- adapter drift from the supported DevAgent path
