# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Boundaries

### Proxy boundary
The seam between the client-facing API ghc-proxy exposes (OpenAI- or Anthropic-compatible) and the GitHub Copilot upstream it actually calls. Each boundary has its own compatibility contract: the client-facing side must stay faithful to the protocol it advertises, while Copilot-specific quirks are absorbed inside the proxy. A field crossing toward Copilot must be preserved, intentionally translated, or explicitly rejected — never silently leaked.

### Translation policy
The per-field decision about how a value crosses the proxy boundary: kept exactly, translated losslessly into the upstream shape, or rejected before dispatch. The point is that an incompatibility with Copilot is never resolved by silently dropping a caller-visible field, because that would change request semantics the client still believes are in force.

## Messages Execution Strategies

The registry selects one strategy per request for `POST /v1/messages`, based on the resolved model's supported endpoints and the payload's semantics.

### Execution Strategy
A self-contained handler for one request path — it owns body preparation, upstream endpoint selection, response processing, and error mapping. Route handlers are thin orchestrators that pick a strategy from a registry rather than branching inline.

### Native Messages
The strategy that forwards an Anthropic Messages request directly to Copilot's native `/v1/messages` endpoint with no protocol translation. Preferred when the model supports the endpoint and the payload carries nothing the native path cannot represent.

### Responses Translation
The strategy that translates an Anthropic Messages request into an OpenAI Responses request, calls Copilot's `/responses` endpoint, and translates the result back to Anthropic. Used when a payload feature (such as structured output) can only be preserved through the Responses representation.

### Chat Completions Fallback
The strategy that translates an Anthropic Messages request into an OpenAI Chat Completions request and back. The universal fallback when a model supports neither native Messages nor Responses; it cannot represent every Anthropic feature, so requests that would lose meaning on this path are rejected upstream of it instead.

## Routing

### Compact request
A conversation-summarization request, identified by a recognizable system-prompt signature that Claude Code sends when condensing context. When small-model routing is enabled, a compact request may be rerouted to a cheaper model, provided that model preserves the original's endpoint support and required capabilities.

### Model fallback
Resolution of a requested model family prefix (e.g. `claude-opus-*`) to a concrete Copilot model when no exact match exists. Distinct from a model rewrite, which substitutes a specific configured `from` pattern for a `to` model across all endpoints.
