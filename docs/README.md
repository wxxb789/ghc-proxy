# Documentation

## Design

Architecture and design documentation for ghc-proxy.

See [docs/design/](design/README.md) for the full index. Key documents:

- [Architecture Overview](design/architecture-overview.md) -- High-level system architecture, request flow, and design principles
- [Module Structure](design/module-structure.md) -- Source code organization
- [Translation Pipeline](design/translation-pipeline.md) -- Protocol translation (Anthropic <-> OpenAI, Anthropic <-> Responses)
- [Execution Strategy](design/execution-strategy.md) -- The `ExecutionStrategy` pattern
- [Model Routing](design/model-routing.md) -- Model resolution and execution path selection
- [Streaming](design/streaming.md) -- SSE streaming architecture and error recovery
- [Error Handling](design/error-handling.md) -- Error classification and translation policy
- [State and Configuration](design/state-and-config.md) -- Global state, config file, CLI flags

## Research

Investigation notes and findings from upstream API behavior analysis.

| Document | Description |
|----------|-------------|
| [Copilot Token Usage](research/copilot-token-usage.md) | How Copilot returns token usage across all API paths |
| [Builtin Tool Support](research/builtin-tool-support.md) | Which builtin tools actually run, per model family and boundary |
| [Responses Web Search](research/responses-web-search.md) | Whether `/responses` supports built-in web search, and whether it actually searches |
| [grok-4.5 Request Schema](research/grok-4.5-schema.md) | Accepted and rejected `/responses` fields for the one xAI model |
| [Competitive Analysis: LiteLLM](research/competitive-analysis-litellm.md) | LiteLLM proxy comparison and feature gap analysis |
| [Environment Variables](research/environment-variables.md) | Environment variable reference and configuration |

## Reference

| Document | Description |
|----------|-------------|
| [Anthropic Translation Matrix](anthropic-translation-matrix.md) | Field-level translation compatibility for the chat-completions fallback |
| [Messages Routing and Translation](messages-routing-and-translation.md) | Per-model routing decision logic and Responses API compatibility |
| [Responses Stream Compatibility](responses-stream-compatibility.md) | Streaming identity normalization contract for the `/v1/responses` passthrough path |
| [Responses Upstream Notes](responses-upstream-notes.md) | Live upstream compatibility observations and input sanitization policies |

## Testing Notes

- `bun test` is part of the publish gate and includes the public API smoke suite in `tests/contract-smoke.test.ts`.
- Use route-specific tests such as `tests/embeddings.test.ts` for proxy-side normalization that should not regress.
- CI runs the main suite first, then re-runs `tests/token-file-removal.test.ts` and `tests/token-refresh-retry.test.ts` in a separate Bun process. Those two files `mock.module()` the GitHub client, and Bun's process-wide module-mock registry leaks the stub into `tests/clients-auth.test.ts`'s real-client routing tests.
- This split should be removed once Bun isolates `mock.module()` per file.

## Project Planning

| Document | Description |
|----------|-------------|
| [TODO](TODO.md) | Tracked future-work items (best-practice improvements and research questions) |
