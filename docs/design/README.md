# Design Documentation

Architecture and design documentation for ghc-proxy.

## Documents

| Document | Description |
|----------|-------------|
| [Architecture Overview](architecture-overview.md) | High-level system architecture, request flow, public and operational endpoints, Dashboard observability, and design principles |
| [Module Structure](module-structure.md) | Source code organization and responsibility of each module |
| [Execution Strategy](execution-strategy.md) | The `ExecutionStrategy` and `runPipeline()` patterns shared by model-generation routes |
| [Translation Pipeline](translation-pipeline.md) | Protocol translation architecture (Anthropic <-> OpenAI, Anthropic <-> Responses) |
| [Model Routing](model-routing.md) | Model resolution, capability detection, execution path selection, and small-model routing |
| [Streaming](streaming.md) | SSE streaming architecture, per-path translation, and error recovery |
| [Error Handling](error-handling.md) | Error classification, validation, translation policy, and error flow |
| [Upstream Request Queue](upstream-request-queue.md) | Global Copilot back-pressure, 429 retry, and stream-aware queue slot ownership |
| [State and Configuration](state-and-config.md) | Global state management, config file, CLI flags, and startup sequence |
| [Dashboard Observability](dashboard-observability.md) | Local Dashboard projections, access control, lifecycle events, and data-minimization boundaries |
| [Migration: Hono → Elysia](migration-hono-to-elysia.md) | Historical completion record for the 2026-03-13 framework migration; verification counts are snapshot evidence, not current totals |

## Design Candidates

Proposed designs that are **not yet implemented**. They record deferred refactors so the systemic root cause is captured against a written plan; do not treat them as describing current behavior.

| Document | Description |
|----------|-------------|
| [Native Messages Reconciliation Layer](native-reconciliation-layer.md) | **Candidate.** Collapse the native `/v1/messages` path's imperative Anthropic↔Copilot reconciliation steps into a declarative pipeline if a real ordering defect or operator-toggle requirement makes the current straight-line implementation insufficient. |

## Related Documentation

| Document | Location |
|----------|----------|
| [Anthropic Translation Matrix](../anthropic-translation-matrix.md) | Detailed translation compatibility matrix for the chat-completions fallback path |
| [Messages Routing and Translation](../messages-routing-and-translation.md) | Per-model routing decision logic and Responses API compatibility policies |
| [Responses Stream Compatibility](../responses-stream-compatibility.md) | Streaming identity normalization contract for the `/v1/responses` passthrough path |
| [Copilot Token Usage](../research/copilot-token-usage.md) | How Copilot returns token usage across all API paths, and local estimation via gpt-tokenizer |
| [Tool Support Probe](../../scripts/probes/tool-support.ts) | Tests whether each builtin tool actually *runs* per model and boundary, not just whether it is accepted (`--json` for diffable snapshots) |
| [Cache Threshold Probe](../../scripts/probes/cache-threshold.ts) | Tests per-model prompt caching minimum token thresholds |
