# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Boundaries

### Proxy boundary
The seam between the client-facing API ghc-proxy exposes (OpenAI- or Anthropic-compatible) and the GitHub Copilot upstream it actually calls. Each boundary has its own compatibility contract: the client-facing side must stay faithful to the protocol it advertises, while Copilot-specific quirks are absorbed inside the proxy. A field crossing toward Copilot must be preserved, intentionally translated, or explicitly rejected — never silently leaked.

### Translation policy
The per-field decision about how a value crosses the proxy boundary: kept exactly, translated losslessly into the upstream shape, or rejected before dispatch. The point is that an incompatibility with Copilot is never resolved by silently dropping a caller-visible field, because that would change request semantics the client still believes are in force.

A policy that rejects or strips a field asserts something about the upstream, and that assertion needs observed upstream behavior behind it — normally a probe, or an upstream error that names the constraint itself. The proxy's own payload types cannot supply it — they describe what the proxy sends, not what Copilot accepts.

### Upstream probe
A script that sends real requests to Copilot to establish what it actually accepts, because the API is reverse-engineered and publishes no schema. A probe is how a translation policy earns the right to reject or strip a field — the exception being a constraint upstream states outright in its own error text, which is already direct evidence and needs no probe to confirm. Where an [[Advertised capability]] covers the question, prefer it: it costs nothing and extends to models that did not exist when the probe ran.

A probe result is a dated snapshot, not a permanent fact: the model set changes, and a policy correct when written can become a capability loss later. Constants that encode a probe result cite the probe and its date, so staleness stays visible. Probes cost real quota and share one rate-limited upstream, so they run sequentially. A probe must also control the state its requests land in — a cached prefix or a warm session makes the measurement describe the leftover state rather than the upstream.

### Advertised capability
What a model's own record says it supports, fetched from Copilot's model list at startup. Distinct from an [[Upstream probe]], which measures what the model actually does: an advertised list is free and available for every model including ones that did not exist when the last probe ran, but it is the model's claim rather than a measurement.

The relationship is asymmetric, and the asymmetry is what makes it usable. A model rejects everything it does not advertise, so the list is trustworthy for *narrowing* a request — clamping to an advertised value never produces a rejected one. The converse fails: at least one model has been observed accepting a level absent from its own list. So an advertised list is a floor on capability, not a description of it, and code should derive from it rather than hardcode model names — a new model then works without a code change.

An advertised set is also not an ordered ladder every model implements a prefix of. Two models may advertise overlapping-but-incomparable sets, so "supports the highest tier, therefore supports the one below" is not a valid inference.

The record describes the model, not the deployment serving it. An advertised capability can still be refused by an account-scoped policy on the infrastructure a model happens to run on — so an advertisement is a claim about what the model can do, never a guarantee that this subscriber may do it. A refusal of that kind needs its own bounded, dated exclusion; folding it into the capability check would state it as a property of the model, which it is not.

## Messages Execution Strategies

The registry selects one strategy per request for `POST /v1/messages`, based on the resolved model's supported endpoints and the payload's semantics.

### Structured output request
A Messages request that constrains the model's reply to a caller-supplied JSON schema. It is the clearest case of a payload feature that changes which strategy may serve the request: the schema is a contract the caller believes is in force, so a strategy that cannot carry it must not serve the request silently.

Dropping the schema and answering anyway is the failure mode this guards against — the caller receives ordinary prose while still believing the constraint applied. When no strategy can preserve it, the proxy rejects the request instead.

### Execution Strategy
A self-contained handler for one request path — it owns body preparation, upstream endpoint selection, response processing, and error mapping. Route handlers are thin orchestrators that pick a strategy from a registry rather than branching inline.

### Native Messages
The strategy that forwards an Anthropic Messages request directly to Copilot's native `/v1/messages` endpoint with no protocol translation. Preferred when the model supports the endpoint and the payload carries nothing the native path cannot represent — a structured output request is the standing exception, since the native path cannot carry the schema.

### Responses Translation
The strategy that translates an Anthropic Messages request into an OpenAI Responses request, calls Copilot's `/responses` endpoint, and translates the result back to Anthropic. Used when a payload feature can only be preserved through the Responses representation, which today means a structured output request.

### Chat Completions Fallback
The strategy that translates an Anthropic Messages request into an OpenAI Chat Completions request and back. The universal fallback when a model supports neither native Messages nor Responses; it cannot represent every Anthropic feature, so requests that would lose meaning on this path — a structured output request among them — are rejected upstream of it instead.

## Routing

### Compact request
A conversation-summarization request, identified by a recognizable system-prompt signature that Claude Code sends when condensing context. When small-model routing is enabled, a compact request may be rerouted to a cheaper model, provided that model preserves the original's endpoint support and required capabilities.

### Model fallback
Resolution of a requested model family prefix (e.g. `claude-opus-*`) to a concrete Copilot model when no exact match exists. Distinct from a model rewrite, which substitutes a specific configured `from` pattern for a `to` model across all endpoints.

### Overload fallback
An opt-in, exact effective-model mapping used only after a terminal model-scoped `529` or a pre-existing local cooldown for that source model. It is not missing-model resolution: the source was valid, but temporarily overloaded. The pipeline may rebuild and dispatch one compatible advertised target with no fresh retry allowance, then discloses the actual served model. Mappings are one-hop choices rather than a traversed graph; blank, same-model, and reciprocal two-node entries are rejected at configuration load.

## Upstream Recovery

### Cooldown scope
The set of requests held behind one upstream capacity deadline. A `429` creates an account cooldown, a `529` with a known final effective model creates a cooldown only for that model, and a model-less `529` remains request-scoped. Scope controls admission; it does not cancel active streams or reserve per-model queue capacity.

### Recovery budget
The one request-local monotonic deadline created at the first approved retryable outcome or the first encounter with an already-active cooldown. It defaults to 60 seconds and covers later cooldown/backoff waits, queue acquisition, attempts until `fetch()` returns a `Response`, and an optional overload fallback. The first attempt uses the normal upstream timeout. A committed `Response` ends recovery timing; body and stream handling continue under their normal timeout and are never replayed.
