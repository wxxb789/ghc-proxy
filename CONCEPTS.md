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

A result is scoped to everything the request varied: the boundary, the request schema, the [[Execution mechanism]] of the thing under test, and what the prompt required. A verdict recorded without naming those reads wider than its evidence. Three failure shapes recur. An upstream error naming a field path in the request describes the payload, not the capability, so it is no verdict at all. A functional check whose prompt could be satisfied without the tool cannot separate "declined to use" from "unable to use". And on a boundary that ignores the field under test, success is returned for anything, so a passing result proves nothing — which is why a probe carries both a control that must pass and one that must fail.

### Advertised capability
What a model's own record says it supports, fetched from Copilot's model list at startup. Distinct from an [[Upstream probe]], which measures what the model actually does: an advertised list is free and available for every model including ones that did not exist when the last probe ran, but it is the model's claim rather than a measurement.

The relationship is asymmetric, and the asymmetry is what makes it usable. The dated probes show that advertised values are conservative targets for *narrowing* a request: clamping to an advertised value avoids the rejection seen for unsupported values. But absence from the list is not proof of rejection — `gpt-5.3-codex` and `grok-4.5` have accepted unadvertised efforts. So an advertised list is a safe floor on capability, not an exact description of it, and code should derive conservative targets from it rather than hardcode model names.

An advertised set is also not an ordered ladder every model implements a prefix of. Two models may advertise overlapping-but-incomparable sets, so "supports the highest tier, therefore supports the one below" is not a valid inference.

The record describes the model, not the deployment serving it. An advertised capability can still be refused by an account-scoped policy on the infrastructure a model happens to run on — so an advertisement is a claim about what the model can do, never a guarantee that this subscriber may do it. A refusal of that kind needs its own bounded, dated exclusion; folding it into the capability check would state it as a property of the model, which it is not.

### Execution mechanism
Who runs a tool once the model decides to use it: the upstream executes it and returns a result, or the model emits a call and the caller executes it. The distinction decides what counts as proof that the tool works — a result coming back, versus a correctly-named call going out — so a check written for one mechanism reports the other as broken.

Two tools may share a name and differ in mechanism, and their support verdicts are then independent: the upstream can refuse to run its own built-in version of a capability while happily emitting calls to a caller-supplied tool of the same name. A capability claim that identifies a tool only by its word is therefore ambiguous, and the two readings carry very different consequences — a blocked built-in is narrow and a caller can rename around it, whereas a filtered name would affect every client and admit no workaround.

### Builtin tool
A tool the caller declares by a versioned type tag rather than by supplying its own schema, so the upstream both defines and — for server-mechanism tools — runs it. Gating applies to the tag, not to the tool's name: a caller-defined tool that happens to reuse the name of a blocked builtin is an ordinary tool and is unaffected.

Support for these varies by boundary and does not transfer between them, and a boundary may ignore the type tag entirely, treating the declaration as an ordinary tool. Where that happens the tag is not a capability signal at all, and reading acceptance as support records a capability that boundary does not have.

## Messages Execution Strategies

The registry selects one strategy per request for `POST /v1/messages`, based on the resolved model's supported endpoints and the payload's semantics.

### Structured output request
A Messages request that constrains the model's reply to a caller-supplied JSON schema. It is the clearest case of a payload feature that changes which strategy may serve the request: the schema is a contract the caller believes is in force, so a strategy that cannot carry it must not serve the request silently.

Dropping the schema and answering anyway is the failure mode this guards against — the caller receives ordinary prose while still believing the constraint applied. When no strategy can preserve it, the proxy rejects the request instead.

### Execution Strategy
A self-contained handler for one request path — it owns body preparation, upstream endpoint selection, response processing, and error mapping. Route handlers are thin orchestrators that pick a strategy from a registry rather than branching inline.

### Native Messages
The strategy that forwards an Anthropic Messages request directly to Copilot's native `/v1/messages` endpoint with no protocol translation. Preferred when the model supports the endpoint and the payload can be represented without weakening its semantics. For structured output, native routing additionally requires the model to advertise `structured_outputs` and the format to be safely reducible to Copilot's accepted `{ type, schema }` shape: an optional `name` may be removed as a label, but `description` and `strict` keep the request off this path because dropping either would change the caller's contract.

### Responses Translation
The strategy that translates an Anthropic Messages request into an OpenAI Responses request, calls Copilot's `/responses` endpoint, and translates the result back to Anthropic. Used when native Messages is unavailable or when the payload cannot be served there without semantic loss and the model exposes `/responses`. A structured output request carrying `description` or `strict` is the clearest payload-sensitive case.

### Chat Completions Fallback
The strategy that translates an Anthropic Messages request into an OpenAI Chat Completions request and back. It is selected when neither native Messages nor Responses can serve the request. It cannot represent every Anthropic feature, so requests that would lose meaning on this path — a structured output request among them — are rejected instead of being silently reduced.

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
