# Review Guide

Review priorities for `devagent-runner`:

1. Correctness
2. Regression risk
3. Contract drift
4. Test coverage
5. Docs parity

Blocking findings include:

- broken workspace prepare/cleanup behavior
- event ordering or result-shape regressions
- cancellation or timeout bugs
- adapter behavior claiming support without validation evidence
- docs overstating experimental adapter maturity

PR expectations:

- keep changes runner-focused
- include test coverage for lifecycle changes
- include explicit validation evidence for “live-validated” claims
