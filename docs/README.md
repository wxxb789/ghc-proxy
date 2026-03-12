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

## Reference

| Document | Description |
|----------|-------------|
| [Anthropic Translation Matrix](anthropic-translation-matrix.md) | Field-level translation compatibility for the chat-completions fallback |
| [Messages Routing and Translation](messages-routing-and-translation.md) | Per-model routing decision logic and Responses API compatibility |
