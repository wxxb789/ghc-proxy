---
artifact_contract: "ce-handoff/v1"
date: "2026-11-04"
title: "M365 Reliability and Capability Analysis Handoff"
summary: "Project-grounded conclusions on agent-loop verification, endpoint discovery, semantic fidelity, recovery, and future upstream capabilities."
keywords: ["m365", "endpoint-discovery", "agent-loop", "semantic-fidelity", "verification", "handoff"]
repository: "ghc-proxy"
resume_focus: "Validate task-level behavior and establish the official client's gateway selection mechanism before designing implementation changes."
---

# M365 Reliability and Capability Analysis Handoff

## Purpose and authority

This is an analysis handoff, not an implementation plan or a claim that the
proposed work has shipped. It records project-local evidence, decision
rationales, alternatives, uncertainties, and acceptance criteria.

The user requested a deeper assessment of useful engineering improvements,
with particular attention to whether the M365 endpoint is dynamic, followed by
a standalone document in `docs/`. The user prefers implementations that follow
this repository's style rather than copied code.

The priority ordering and recommendations below are the assistant's assessment,
not user approval to implement them. This handoff grants no authority to commit,
push, change remote resources, provision agents, or consume live quota.

## Executive conclusion

The highest-value improvement is stronger proof that the proxy preserves a
real client's task semantics across a complete tool loop. Endpoint discovery
is the other immediate research priority: establish how the official client
selects its gateway before adding configuration or guessing hostname rules.

Preserve the current native Messages path and conservative generation replay
policy. Do not mix prompt-based tool emulation, behavioral retries, or a
semantically different service into that path as transparent recovery.

Additional upstream capabilities may justify a separate investigation, but
capability expansion is not a prerequisite for reliability work.

## 1. Evidence map and current state

All paths below are repository-local. Symbols are more durable landing points
than line numbers; recheck current contents before acting.

| Reference | What matters |
| --- | --- |
| [M365 design](../design/m365-upstream.md) | FX Gateway surface, broker credentials, supported catalog, hostname target, loopback boundary, recorded live observations, and current endpoint restrictions. |
| [M365 client constants and catalog](../../src/clients/m365-upstream.ts) | `M365_BASE_URL`, `fetchM365Models`, `normalizeM365Catalog`, `m365Headers`, and family fallbacks. |
| [API configuration](../../src/clients/api-config.ts) | `copilotBaseUrl` returns the M365 constant before considering the GitHub-derived `copilotApiBase`. |
| [Target initialization](../../src/accounts/target-runtime.ts) | `initializeM365Target` acquires credentials and catalog; catalog 401/403 is not converted into a static-catalog success. |
| [Broker credential source](../../src/clients/msc-auth.ts) | Credential-identity-keyed token caching, acquisition deduplication, helper boundary, and expiration handling. |
| [Copilot client](../../src/clients/copilot-client.ts) | `requestStreamable` restricts generation HTTP-status replay to capacity responses; JSON/SSE share request dispatch. |
| [Capacity error classification](../../src/lib/error.ts) | `resolveCapacityCooldownScope`: 429 is account-scoped; 529 is model-scoped when a model is known, otherwise request-scoped. |
| [Upstream queue](../../src/clients/upstream-queue.ts) | Existing admission, cooldown, recovery budget, and Retry-After handling; do not build a parallel scheduler without an observed need. |
| [Tool capability probe](../../scripts/probes/tool-support.ts) | Acceptance and functional trace are separate; `classify` distinguishes a client call from a server result trace. |
| [Tool cases](../../scripts/lib/tool-cases.ts) | Existing boundary-specific schemas, prompts, proof types, execution mechanisms, and controls. |
| [Execution strategies](../design/execution-strategy.md) | Native and translated paths, stream termination, error hooks, cancellation, and cleanup ownership. |
| [Capability verdict convention](../solutions/conventions/capability-verdicts-name-a-schema-and-a-mechanism.md) | Existing requirement to name boundary, schema, execution mechanism, and prompt; positive and negative controls. |
| [Upstream evidence convention](../solutions/conventions/upstream-types-are-not-contract-evidence.md) | Hand-written types and old observations are not permanent upstream contracts. |
| [Runtime evidence limits](../solutions/testing/green-suite-is-evidence-about-one-runtime.md) | Bun success does not establish Node or platform behavior. |

### Confirmed by current repository inspection

- M365 is a hostname-selected route target alongside GitHub targets.
- The configured M365 gateway base is
  `https://msit.loki.delve.office.com/api/v1/llmapi`.
- The M365 inference surface currently exposed by this target is Anthropic
  Messages, not general Chat Completions, Responses, or Embeddings dispatch.
- The upstream catalog contains more endpoint families than the proxy exposes;
  the supported public catalog filters to the Messages subset.
- The credential resource is Microsoft FX Gateway, acquired through a Windows
  broker helper. Source runtime neutrality is separate from credential-platform
  availability.
- `m365Headers` generates fresh `X-ConversationId` and `X-ClientCallId` values.
- The M365 base currently has no dedicated override in `copilotBaseUrl`.
- Existing capability probes validate acceptance and expected structured traces.
  A client-tool verdict of `called` does not independently establish that a
  consumer executed the call or completed the task.

### Recorded evidence, not newly reproduced here

The M365 design document records live catalog results, working model names,
streaming/tool-call checks, output-token bounds, and a large-context request.
Those remain dated observations from that document. This handoff did not rerun
live authentication, inference, limit bisection, or cross-tenant experiments.

### Unknowns that materially affect the recommendation

- How the official coding-agent client obtains and selects its gateway URL.
- Whether that selection varies by account, tenant, region, release ring,
  client version, or feature availability.
- Whether reusing `X-ConversationId` changes affinity, caching, accounting, or
  generation behavior on this particular gateway.
- Whether the gateway has in-band quota/entitlement failures not represented by
  ordinary HTTP errors or documented protocol events.
- Which additional service capabilities would produce enough user benefit to
  justify a separate credential and protocol implementation.

## 2. Priority 1: verify complete agent-loop outcomes

### Problem

A proxy can return a valid response with a correctly named tool call while
still breaking the user's task. Failures can occur when the consumer executes
that call, submits its result, and asks the next question.

The existing tool probe deliberately answers a narrower question. Its
`called`/`ran` distinction is useful and should remain intact; it should not be
relabelled as end-to-end task completion.

### Recommendation

Add a small complementary task-level verification layer rather than replacing
capability probes or building a general benchmark platform.

The useful contract is:

```text
client request
  -> proxy ingest / transform / dispatch
  -> structured tool call
  -> isolated local execution
  -> result submitted through the client-facing protocol
  -> subsequent model turn
  -> independent verification of the final task state
```

A minimal task reads a per-run unpredictable value, changes a fixture according
to that value, and leaves unrelated fixture data untouched. The verifier belongs
to the harness, not to the model's answer. At least one real consumer-client run
should complement a custom protocol driver because their serialization and
side requests can differ.

### Consumer-visible failure cases to cover

- Tool call IDs remain associated with the right result across a round trip.
- Multiple calls and results preserve identity, order, and content.
- Streaming and non-streaming produce the same required task outcome.
- Native and translated strategies preserve their documented common semantics.
- Malformed tool arguments produce a real recoverable failure, not fabricated
  success or silently altered arguments.
- Client cancellation does not leak work or state into the next request.
- Title generation and other side requests do not contaminate inference state.
- Repeated or concurrent requests with the same opener remain isolated.

### Experimental controls

- Give each run fresh task state and unpredictable fixture data. A fixed secret
  or answer substring is insufficient proof of a read.
- Use an appropriate sandbox; model-generated commands must not inherit host
  credentials or unrestricted access to the checkout.
- For a strategy comparison, keep the same reachable upstream/model and test
  only the strategies' common supported contract. Otherwise label the extra
  variables explicitly.
- Separate transport/capacity retries from behavior-changing retries and model
  fallback. Report first-attempt and assisted outcomes separately.
- Report invalid/unmeasured runs and their causes, not only a score with those
  runs removed. Availability is part of the user experience.
- Interleave comparative runs or otherwise control for changing account and
  service state. A later arm can be slower because of accumulated load.
- Record runtime, client version, model, route, relevant policy, timestamps,
  upstream build when available, attempts, upstream dispatches, latency, and
  final verification result. Never fabricate missing metadata.

### Success criterion

A useful result proves both that the operation occurred in the intended local
fixture and that the proxy preserved the protocol sequence needed to finish it.
A green suite, a well-formed call, or a model-written completion claim alone does
not satisfy this criterion.

Permanent regression cases should cover concrete boundaries and transitions.
Exploratory live comparisons remain opt-in and quota-aware, not a new default CI
requirement.

## 3. Priority 2: establish endpoint selection before designing discovery

### Current evidence

`copilotBaseUrl` selects a fixed M365 base. The code proves that current behavior;
it does not prove that the service address is universal or that it must vary.
A hostname's spelling is not evidence of a tenant or ring algorithm.

GitHub's token-derived `copilotApiBase` is a separate mechanism. Its existence
does not establish an equivalent mechanism for FX Gateway.

### Recommended investigation

Observe an authorized official-client session and establish this chain:

```text
selected account / feature
  -> bootstrap, configuration, or built-in endpoint selection
  -> actual request origin and path
  -> authentication resource / audience
  -> routing inputs and redirects, if any
  -> response protocol and serving metadata
```

Record sanitized origins, methods, paths, resource identifiers, and relevant
metadata. Do not persist bearer tokens, authorization codes, refresh tokens,
cookies, full authenticated URLs, or unrelated payload contents.

If a token is opaque, do not assume it is a decodable JWT. If claims are decoded
for diagnostics, that does not verify their signature or establish permission
to forward the token elsewhere.

Questions to settle:

1. Is the URL built into the client or supplied by a response?
2. If supplied, which stable request obtains it and which field is authoritative?
3. Does changing an authorized account or feature change the URL or resource?
4. Are public entrypoint selection and backend affinity separate mechanisms?
5. What observable event makes cached endpoint information stale?

A single account establishes only that account's observed selection. Broader
claims require corresponding evidence; do not extrapolate a hostname formula
from one successful example.

### Evidence ladder

| Observation | Establishes | Does not establish |
| --- | --- | --- |
| DNS resolves | A name resolves in the observed environment. | Correct service, authentication, entitlement, or inference. |
| HTTP response, including 401/403 | An HTTP request received a response. | Correct audience, feature availability, or a working model. |
| Catalog succeeds | Catalog access and advertised metadata for that request. | Every listed operation works end to end. |
| Generation succeeds | That request worked on that route. | Universal account, model, runtime, or feature support. |
| Independent task verifier passes | The required task outcome occurred under the recorded conditions. | Other contexts or permanent future support. |

### Decision rule

- If a supported metadata/configuration response provides the endpoint, use that
  evidence to design scoped discovery and refresh behavior.
- If a verified constant is the actual client mechanism, document its provenance
  and re-verification conditions; do not invent discovery.
- If multiple verified deployments need explicit selection without discovery,
  evaluate an operator override as a separate configuration decision.

An override is not discovery. It also creates a credential-routing boundary:
validate allowed destinations and schemes, handle redirects deliberately, and
avoid forwarding resource-bound tokens to arbitrary hosts. Catalog and inference
must agree on the selected endpoint. Do not automatically repurpose the
GitHub-derived `copilotApiBase` for M365.

### Session header question

Keep the current fresh-per-request `X-ConversationId` behavior unless controlled
measurement establishes a reason to change it. Correlation IDs, stateful
conversation IDs, affinity keys, and idempotency keys are different concepts.
The name of a header alone does not determine its semantics.

## 4. Preserve semantic fidelity instead of changing model behavior invisibly

### Recommendation

Prefer native protocol expression whenever it exists. Reuse the repository's
translation-policy conventions to describe exact, lossy, and unsupported
behavior rather than adding a second compatibility framework.

Prompt rewriting, synthetic tool instructions, forced follow-up messages,
content heuristics, history rewriting, and model substitution can change the
answer even when the JSON schema remains valid. They are product behavior, not
merely transport repair.

Do not insert such mechanisms into native Messages as transparent compatibility
work. Where translation is required, verify that its declared policy corresponds
to actual client outcomes.

Model identity also needs care: a catalog name, HTTP 200, model self-description,
or a content-origin marker alone is not independent proof of the underlying
model version. Record the advertised/requested identity and the evidence actually
available; do not turn an inferred identity into a stronger guarantee.

### Hidden-state cost

A stateful upstream can retain text that the proxy removed from the client
response. That creates two histories: what the client saw and what the service
remembers. Removing fabricated tool results from an outgoing response does not
remove them from server-side context.

Do not introduce prompt-fingerprint conversation pooling as a free optimization.
If stateful support becomes necessary, its design needs explicit conversation
identity, account ownership, concurrency control, continuation validation,
expiration, and recovery semantics. Matching an opener or counting messages is
not sufficient to establish history equivalence.

## 5. Interpret failures at the upstream boundary

### Existing foundation

The queue already implements cooldown scopes, a bounded recovery budget, and
Retry-After handling. Generation replay is intentionally narrower than general
transient-status retry. Reuse that ownership.

### Recommended classification model

Keep the following questions distinct when evidence supports the distinction:

- Is this authentication or entitlement failure?
- Is this account-rate capacity, model capacity, or a separately metered budget?
- Is this a protocol/schema failure?
- Is this a deliberate refusal or filter event?
- Is this transport failure, interrupted streaming, or missing terminal state?
- Is this a normal answer that simply did not perform the requested operation?

Structured terminal results can carry failure information absent from text
deltas. Evaluate them where the protocol defines their meaning. Do not treat
any empty response as throttling or assume content implies success.

Do not globally scan ordinary assistant prose for English quota phrases and
convert matches into 429. A discussion or quotation of a refusal is still valid
content. Any in-band classifier needs source-specific authoritative signals and
negative controls before it can affect user responses or cooldown state.

A known budget reset is different from estimated exponential backoff. Prefer
verified upstream timing when available; do not infer reset schedules from key
names, copy undocumented refill constants, or derive a universal schedule from
one account's behavior.

### Replay and streaming boundaries

- A failed generation may already have consumed quota or performed work.
- A behavioral retry changes the conversation; a fallback can change the model.
- Once output bytes reach a consumer, ordinary streaming cannot retract them.
- Once headers are committed, a later error cannot become a different HTTP
  status. It needs the public protocol's error/termination semantics.
- A bounded holdback is appropriate only for a demonstrated, narrowly defined
  ambiguity. It is not a universal solution to late failures.

A generic counterexample is useful for future stream designs: after emitting
`abc`, an authoritative snapshot changes to `XYZdef`, then extends to
`XYZdef!`. Suppressing the replacement snapshot but appending its later suffix
can yield `abc!`. That is not a prefix of the final answer. This is a design
counterexample, not a reproduced bug in ghc-proxy.

The existing strategy documentation describes different termination/error hooks
for native and translated paths. Inspect the affected implementation before
claiming universal error synthesis or adding another layer.

## 6. Capability expansion is a separate product decision

Potential investigations include image generation, grounded search, work-data
retrieval, and server-side actions. These are candidate outcomes, not claims that
this gateway supports or lacks them.

For each candidate, establish:

1. The user outcome unavailable through the current supported surface.
2. The actual endpoint, request contract, resource audience, and entitlement.
3. Whether a tool merely registers, emits a call, or executes with a verified
   result. A successful discovery handshake is not tool execution.
4. Whether artifacts require another resource-specific token and which URLs
   are trusted. A response-provided URL is not automatically safe for a
   credential-bearing fetch.
5. Whether the operation changes tenant resources or executes remotely.
6. Whether native public API semantics can be preserved without prompt emulation.

If a materially different service is justified, assess an explicitly selected
upstream/strategy with its own credential and capability boundaries. Do not
silently route a failed native Messages request to it: history, tools, model
identity, accounting, and privacy may all differ.

A browser-based login mechanism for one first-party client/resource does not
prove it can obtain FX Gateway credentials. Keep the existing broker path until
an alternative is independently established for the required client and scope.
Different authentication methods have different platform and credential-storage
tradeoffs; one is not universally better merely because it avoids a browser.

No remote provisioning, action invocation, public tunnel, or additional live
quota use is authorized by this document.

## 7. Decision register and revised priorities

These are assistant recommendations, not implemented changes.

| Topic | Disposition | Rationale | Evidence that could change it |
| --- | --- | --- | --- |
| Task-level agent-loop verification | Highest implementation candidate. | Covers the gap between a structured call and a completed consumer task. | A current harness already covering the same outcomes; inspect before duplicating it. |
| Official-client endpoint selection investigation | Highest research candidate. | Addresses the real endpoint question instead of adding guessed configuration. | A verified existing discovery/provenance record that answers the questions in section 3. |
| Semantic-fidelity and terminal-error checks | Strengthen existing paths when a concrete gap is observed. | Existing strategy/policy/queue ownership is preferable to parallel infrastructure. | A reproduced boundary defect and an appropriate regression oracle. |
| Dedicated base override | Defer pending endpoint evidence. | Useful escape hatch only for a demonstrated need; adds credential-routing risk. | Verified alternate deployment origins without a usable discovery mechanism. |
| Broad raw payload/frame dumping | Not a default improvement. | Prompts, tool results, authenticated URLs, and artifacts may contain sensitive data. | A specific diagnostic need with opt-in capture, redaction, bounded retention, and access controls. |
| Prompt-based tool emulation on native Messages | Reject as transparent adaptation. | Alters role, tool, and behavioral semantics that the native contract already expresses. | A separately approved service/product contract, not an incidental native-path fix. |
| Prompt-fingerprint stateful session pool | Do not add. | Hidden history and concurrency/isolation responsibilities outweigh unproven savings. | A stateful upstream requirement with explicit session identity and verified benefit. |
| Predictive refill-bucket pacing | Defer. | No established FX Gateway refill model; reactive capacity handling already exists. | Controlled measurements showing a stable budget model and meaningful benefit. |
| Additional service capabilities | Separate, bounded investigation. | May add user value but must not weaken the existing contract. | Verified endpoint execution, auth, entitlement, and independent outcome proof. |
| Generic new methodology document/framework | Reuse existing conventions first. | The repository already has detailed capability/evidence rules. | A specific uncovered rule that warrants a small durable addition. |

Earlier candidate priorities favored URL configurability and diagnostic dumps.
The final assessment moves both below task-level verification and endpoint
provenance: neither configuration flexibility nor more captured bytes proves
correct routing or correct user outcomes.

## 8. Suggested continuation and acceptance boundaries

The sequence below is a recommendation, not an instruction to start work.

1. Inventory the relevant existing tests, probes, consumer smoke checks, and
   capture facilities. Reuse their conventions; do not infer whole-repository
   absence from the limited files examined for this handoff.
2. Define one small task with an independent verifier and a real tool-result
   round trip. Establish an initial result on one supported path, then extend
   only to meaningful boundaries or consumer clients.
3. Investigate official-client endpoint selection in an authorized environment.
   Keep the endpoint question open if that environment is unavailable; complete
   any reachable local verification work independently.
4. Use the resulting evidence to select a narrow production change, if any.
   Update the relevant existing design and contract documentation with that
   change rather than treating this research snapshot as the implementation spec.

### Evidence required before declaring the work complete

- A task result is independently verified, not inferred from response text.
- The changed public boundary, runtime, and relevant client path are exercised.
- Endpoint claims identify the observed client/account context and exact source
  of the address; unexplained variability remains labelled unknown.
- No unapproved destination receives credential material.
- Retry-assisted success, model fallback, capacity failures, and unmeasured runs
  remain distinguishable in reporting.
- No alternate service or new prompt behavior is introduced invisibly.

## 9. Verification and continuity limits

For this documentation handoff, current project files and design conventions
were inspected. No application behavior was changed. No live authentication,
inference, tenant provisioning, model benchmark, or cross-platform gate was run.
Recorded live results in linked design documents are not new verification.

No claim in this handoff establishes dynamic FX Gateway endpoint discovery,
benefits from stable conversation IDs, support for an additional service, or a
newly reproduced production defect. Those are research questions or design
constraints, explicitly labelled above.

The artifact is stored in the repository's documentation tree, not temporary
session storage. It has not been committed or published by this handoff task;
another machine or checkout needs the file transferred through the user's
normal workflow. Re-read current code and the latest user request before
resuming because implementation and documentation may change independently.
