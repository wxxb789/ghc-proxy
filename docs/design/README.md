# Design Documentation

Architecture and design documentation for ghc-proxy.

## Documents

| Document | Description |
|----------|-------------|
| [Architecture Overview](architecture-overview.md) | High-level system architecture, request flow, endpoints, and design principles |
| [Module Structure](module-structure.md) | Source code organization and responsibility of each module |
| [Execution Strategy](execution-strategy.md) | The `ExecutionStrategy` pattern that unifies all route handlers |
| [Translation Pipeline](translation-pipeline.md) | Protocol translation architecture (Anthropic <-> OpenAI, Anthropic <-> Responses) |
| [Model Routing](model-routing.md) | Model resolution, capability detection, execution path selection, and small-model routing |
| [Streaming](streaming.md) | SSE streaming architecture, per-path translation, and error recovery |
| [Error Handling](error-handling.md) | Error classification, validation, translation policy, and error flow |
| [Upstream Request Queue](upstream-request-queue.md) | Global Copilot back-pressure, 429 retry, and stream-aware queue slot ownership |
| [State and Configuration](state-and-config.md) | Global state management, config file, CLI flags, and startup sequence |
| [Migration: Hono → Elysia](migration-hono-to-elysia.md) | Completed framework migration from Hono to Elysia |

## Related Documentation

| Document | Location |
|----------|----------|
| [Anthropic Translation Matrix](../anthropic-translation-matrix.md) | Detailed translation compatibility matrix for the chat-completions fallback path |
| [Messages Routing and Translation](../messages-routing-and-translation.md) | Per-model routing decision logic and Responses API compatibility policies |
| [Responses Stream Compatibility](../responses-stream-compatibility.md) | Streaming identity normalization contract for the `/v1/responses` passthrough path |
| [Copilot Token Usage](../research/copilot-token-usage.md) | How Copilot returns token usage across all API paths, and local estimation via gpt-tokenizer |
| [Tool Support Probe](../../scripts/probes/copilot-tools.ts) | Tests which server-side tool types each Copilot model accepts (`--json` for diffable snapshots) |
| [Cache Threshold Probe](../../scripts/probes/cache-threshold.ts) | Tests per-model prompt caching minimum token thresholds |
