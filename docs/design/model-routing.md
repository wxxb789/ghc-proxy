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
claudeOpus:   claude-opus-5
claudeSonnet: claude-sonnet-5
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

### Model Endpoint Map (June 17, 2026)

| Model | Endpoints | Notes |
|-------|-----------|-------|
| `claude-opus-4.8` | `/v1/messages`, `/chat/completions` | 1000k ctx |
| `claude-opus-4.7` / `-high` / `-xhigh` | `/v1/messages`, `/chat/completions` | 1000k ctx; `-xhigh` has 8K cache threshold |
| `claude-opus-4.6` | `/v1/messages`, `/chat/completions` | 1000k ctx |
| `claude-sonnet-4.6` | `/v1/messages`, `/chat/completions` | 1000k ctx |
| `claude-haiku-4.5` | `/v1/messages`, `/chat/completions` | 200k ctx |
| `gpt-5.5` | `/responses` | 1050k ctx; same tool support as gpt-5.4 |
| `gpt-5.4` / `-mini` | `/responses` | 1050k / 400k ctx |
| `gpt-5.3-codex` | `/responses` | 400k ctx |
| `gemini-3.5-flash` | `/chat/completions` | 1000k ctx |
| `gemini-3.1-pro-preview` | `/chat/completions` | 1000k ctx |

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

## `anthropic-beta` Header Handling

Clients like Claude Code may send `anthropic-beta: context-1m-2025-08-07` to request 1M context. Copilot does not understand `context-*` beta values, so the proxy **strips** them (along with other Copilot-unsupported betas) before forwarding; remaining beta values pass through. SOTA Anthropic models are natively 1000k context, so no model substitution is performed for the header — it is simply removed.

### Small-Model Routing Details

### Activation

Disabled by default. Requires `smallModel` to be set in config.

### Compact Detection

Identifies Claude Code's conversation summarization requests by matching the system prompt pattern. When detected and `compactUseSmallModel` is enabled, the request is rerouted.

### Safety Checks

Before rerouting, the proxy validates the target small model:
- Must exist in Copilot's model list
- Must preserve the original model's endpoint support
- Must support any required capabilities (tools, vision, thinking)

If any check fails, the original model is used.

## Responses Request Policies

The native OpenAI-style `/v1/responses` route stays close to passthrough by default. Two optional request-mutation policies exist for Copilot `/responses` compatibility and long-session ergonomics:

| Key | Default | Effect |
|-----|---------|--------|
| `responsesApiAutoContextManagement` | `false` | Auto-inject `context_management` for models listed in `responsesApiContextManagementModels` |
| `responsesApiAutoCompactInput` | `false` | Auto-trim `input` to the latest `compaction` item before forwarding |

These policies are both disabled by default. They only apply when explicitly enabled in config.

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
