# Model Resolution and Routing

This document describes how ghc-proxy resolves model identifiers and routes requests to the appropriate execution path.

## Model Resolution

### Fallback Chain

When a client requests a model ID (e.g., `claude-sonnet-4.6`), the resolver checks:

1. **Exact match** -- If the model ID exists in Copilot's cached model list, use it directly
2. **Family fallback** -- If no exact match, map by model family prefix:
   - `claude-opus-*` → configured `claudeOpus` fallback
   - `claude-sonnet-*` → configured `claudeSonnet` fallback
   - `claude-haiku-*` → configured `claudeHaiku` fallback
3. **Pass-through** -- If no family match, forward the ID as-is (let upstream reject it)

### Configuration

Fallbacks can be configured via environment variables or config file (`~/.ghc-proxy/config.json`):

```text
MODEL_FALLBACK_CLAUDE_OPUS      → config.modelFallback.claudeOpus
MODEL_FALLBACK_CLAUDE_SONNET    → config.modelFallback.claudeSonnet
MODEL_FALLBACK_CLAUDE_HAIKU     → config.modelFallback.claudeHaiku
```

Default fallbacks:
```text
claudeOpus:   claude-opus-4.6
claudeSonnet: claude-sonnet-4.5
claudeHaiku:  claude-haiku-4.5
```

## Model Capabilities

The proxy queries each model's metadata from Copilot's model list to determine:

| Capability              | Used For                                             |
|-------------------------|------------------------------------------------------|
| `supported_endpoints`   | Strategy selection (which execution path to use)     |
| `tool_calls`           | Whether tools can be forwarded                       |
| `vision`               | Whether image inputs are supported                   |
| `adaptive_thinking`    | Whether to fill thinking config                      |
| Vision limits          | Max image tokens, max images per request             |

## Execution Path Selection

For `POST /v1/messages`, the handler selects a strategy based on the model's `supported_endpoints`:

```text
Does model support /v1/messages?
  ├── YES → Native Messages Strategy (passthrough)
  └── NO
       ├── Does model support /responses?
       │    ├── YES → Responses Translation Strategy
       │    └── NO  → Chat Completions Fallback Strategy
       └── (default) → Chat Completions Fallback Strategy
```

Priority order matters: native passthrough wins when available. The Responses path is used only when it's the best available. Chat Completions is the universal fallback.

## Small-Model Routing

An optional optimization that reroutes certain requests to a smaller (cheaper/faster) model.

### Activation

Disabled by default. Requires `smallModel` to be set in config.

### Compact Detection

Identifies Claude Code's conversation summarization requests by matching the system prompt pattern. When detected and `compactUseSmallModel` is enabled, the request is rerouted.

### Warmup Detection

Identifies probe/warmup requests. All conditions must be true:
- `anthropic-beta` header contains a warmup marker
- No tools in the request
- No system prompt
- No explicit thinking configuration
- Small `max_tokens` value
- Single short user text message

### Safety Checks

Before rerouting, the proxy validates the target small model:
- Must exist in Copilot's model list
- Must preserve the original model's endpoint support
- Must support any required capabilities (tools, vision, thinking)

If any check fails, the original model is used.

## CAPI Profile Selection

The plan builder selects an API endpoint profile based on model family:

| Model Family | Profile ID | Purpose                                    |
|--------------|------------|--------------------------------------------|
| `claude`     | `claude`   | Claude-specific headers and parameters     |
| (other)      | `base`     | Standard Copilot API headers               |

The profile affects:
- Request headers sent to Copilot
- API base URL construction
- Interaction type defaults
