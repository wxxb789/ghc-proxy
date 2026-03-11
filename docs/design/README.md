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
| [State and Configuration](state-and-config.md) | Global state management, config file, CLI flags, and startup sequence |

## Related Documentation

| Document | Location |
|----------|----------|
| [Anthropic Translation Matrix](../anthropic-translation-matrix.md) | Detailed translation compatibility matrix for the chat-completions fallback path |
| [Messages Routing and Translation](../messages-routing-and-translation.md) | Per-model routing decision logic and Responses API compatibility policies |
