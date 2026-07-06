# Native Messages Reconciliation Layer

> **Status: DESIGN CANDIDATE — proposed, NOT implemented.**
> This document captures a deferred refactor. No code in this PR implements it.
> It exists so the systemic root cause behind issue #45 (and its siblings) is
> recorded, and so a future maintainer can pull the trigger at the right time
> against a written design instead of rediscovering it. See "When to implement"
> for the threshold that should gate the work.

## The Problem

The native `/v1/messages` strategy ([`nativeMessagesEntry`](../../src/routes/messages/strategy-registry.ts)) is a *near-passthrough*: it forwards the Anthropic payload to Copilot's `/v1/messages` with "minimal mutation". Its correctness rests on one implicit assumption:

> **Anthropic request shape ≈ Copilot-accepted shape.**

That assumption is false in a growing number of spots. Anthropic and Copilot's native endpoint disagree on specific request features, and **every disagreement not explicitly normalized leaks outward as a 400** — either from the proxy's own validator or from Copilot upstream. Issue #45 surfaced two such gaps at once; a third was found during live verification.

Today each discovered disagreement is patched with a **new, hand-wired imperative sanitizer** appended to the strategy. As of this writing the native path runs six of them across two files:

| # | Sanitizer | Location | What it reconciles | Driven by |
|---|-----------|----------|--------------------|-----------|
| 1 | `filterThinkingBlocksForNativeMessages` | `transform/sanitize.ts` | Strips stale/placeholder assistant thinking blocks from history | block shape |
| 2 | `convertEnabledThinkingToAdaptive` | `transform/sanitize.ts` | `thinking.enabled` → `adaptive` (+ derived `output_config.effort`) | `capabilities.supports.adaptive_thinking` |
| 3 | `sanitizeOutputConfig` | `transform/sanitize.ts` | Drops/clamps `output_config.effort` | `MODELS_REJECTING_OUTPUT_CONFIG`, `capabilities.supports.reasoning_effort` |
| 4 | `sanitizeCacheControl` | `transform/sanitize.ts` | Normalizes `cache_control` to `{type:"ephemeral"}` | Copilot constraint (temporary) |
| 5 | citations strip | `strategies/native-messages.ts` | Removes top-level `citations` | Copilot constraint |
| 6 | mixed `search_result` flatten | `strategies/native-messages.ts` | Flattens mixed `tool_result.content[]` to text | Copilot constraint |

Plus one **known-missing** reconciler discovered in live testing (issue #45 follow-up): Copilot native `/v1/messages` only accepts `document` blocks whose `source.type` is `base64` or `url`, and rejects Anthropic-valid `text`/`content`/`file` sources with `invalid_pdf_request`. That would be sanitizer #7.

### Symptoms of the accretion

- **No single place to reason about "what does the native path change and why".** The logic is split across `strategy-registry.ts` (four calls) and `native-messages.ts` (two, buried in a `map`), with ordering constraints that are implicit (e.g. #2 must run before #3 so the derived effort is clamped).
- **Not configurable.** Copilot's native constraints shift over time (several sanitizers are explicitly marked "temporary; remove when Copilot accepts X"). There is no way to add/override a reconciliation rule without a code change and release, unlike the Responses path.
- **Silent-drop risk.** Each new field handled by hand is a chance to drop something without recording an `exact`/`lossy`/`unsupported` policy, which AGENTS.md explicitly warns against.
- **Ordering is load-bearing but undocumented.** The `execute` body's call order encodes dependencies that are invisible at the call site.

## Precedent In This Repo

The Responses boundary already solved the isomorphic problem with a **declarative, capability-driven, config-extensible rule engine**: [`parameter-filter.ts`](../../src/transform/parameter-filter.ts).

- `resolveStrippedResponsesParams(model)` composes a **built-in default rule** (any model advertising `reasoning_effort` strips `temperature`/`top_p`) with **user rules** (`responsesApiParameterFilters`, glob-matched by model id), taking the **union**.
- `responsesApiParameterFiltersReplaceDefault` lets user rules fully overwrite the default.
- `applyResponsesParameterFilters(payload, model)` runs the resolved set against the payload.

The native path should adopt the same shape. The only structural difference: Responses reconciliation is homogeneous ("delete these keys"), whereas native reconciliation is **heterogeneous** (convert a shape, flatten a block, clamp a value, strip a key). So the native engine is a *pipeline of named reconcilers* rather than a *set of keys to strip*.

## The Proposed Design

### Core abstraction

```typescript
// src/transform/native-reconcile/types.ts
import type { TranslationPolicy } from '~/lib/translation-policy'
import type { AnthropicMessagesPayload, Model } from '~/types'

interface NativeReconcileContext {
  payload: AnthropicMessagesPayload // mutated in place
  model: Model | undefined
  policy: TranslationPolicy // record exact/lossy/unsupported notes
}

interface NativeReconciler {
  name: string
  /** Cheap guard: does this rule need to run for (payload, model)? */
  appliesTo: (ctx: NativeReconcileContext) => boolean
  /** Reconcile the payload to the Copilot-accepted shape, in place. */
  reconcile: (ctx: NativeReconcileContext) => void
}
```

### The runner

```typescript
// src/transform/native-reconcile/index.ts
export function reconcileNativeMessagesPayload(
  payload: AnthropicMessagesPayload,
  model: Model | undefined,
  policy: TranslationPolicy,
): void {
  const ctx = { payload, model, policy }
  for (const rule of resolveNativeReconcilers(model)) {
    if (rule.appliesTo(ctx)) {
      rule.reconcile(ctx)
    }
  }
}
```

`nativeMessagesEntry.execute` collapses from six scattered calls to one:

```typescript
const nativeMessagesEntry: StrategyEntry<StrategyContext> = {
  name: 'native-messages',
  canHandle: (model, ctx) => /* unchanged */ true,
  async execute(ctx) {
    reconcileNativeMessagesPayload(ctx.anthropicPayload, ctx.selectedModel, policy)
    const strategy = createNativeMessagesStrategy(/* ... */)
    return await runStrategy(strategy, ctx.upstreamSignal)
  },
}
```

### Rule ordering is explicit

`resolveNativeReconcilers` returns the rules in a **declared, documented order**, replacing the implicit call ordering in `execute`. Dependencies become data, not call-site trivia:

```typescript
const BUILTIN_RECONCILERS: ReadonlyArray<NativeReconciler> = [
  staleThinkingBlocksReconciler, // 1
  thinkingShapeReconciler, // 2: enabled -> adaptive (MUST precede #3)
  outputConfigReconciler, // 3: clamp effort vs model
  documentSourceReconciler, // 4: NEW - flatten non base64/url doc sources
  searchResultReconciler, // 5: citations strip + mixed flatten
  cacheControlReconciler, // 6
]
```

### Capability-driven predicates

Each `appliesTo` reads model capabilities and/or known Copilot-constraint tables — no hardcoded model-id lists beyond the constraint tables that already exist (`MODELS_REJECTING_OUTPUT_CONFIG`). Examples:

- `thinkingShapeReconciler.appliesTo` → `payload.thinking?.type === 'enabled' && supportsAdaptiveThinking(model)`
- `documentSourceReconciler.appliesTo` → payload has a `document` block whose `source.type ∉ {base64, url}`
- `outputConfigReconciler.appliesTo` → `payload.output_config != null`

### Config extensibility (mirrors Responses)

A future `nativeMessagesReconcilers` config key can let operators add or disable rules by name/glob without a code change, exactly as `responsesApiParameterFilters` does — useful precisely because so many native rules are marked "temporary until Copilot changes". Built-in rules stay on by default; config can `disable: ["cache-control"]` once Copilot accepts `scope`, turning a code-change-and-release into a config toggle.

### Policy recording

Every reconciler that loses information records a `TranslationPolicy` note (`lossy_*` / `unsupported_*`) instead of silently mutating, satisfying the AGENTS.md "don't silently drop unsupported fields" rule. The mixed-`search_result` flatten and the new document-source flatten are `lossy`; the thinking-shape conversion is `exact` (semantically preserved) with a `lossy` effort-derivation note only when `budget_tokens` had to be bucketed.

## Migration Plan (incremental, behavior-preserving, non-breaking)

1. Introduce `src/transform/native-reconcile/` (types + runner + empty registry). No behavior change.
2. Port the six existing sanitizers into reconcilers **one at a time**, each behind its existing tests, asserting byte-identical forwarded payloads via the `mockMessages` capture harness (`tests/messages-routing.test.ts`). Keep the old functions as thin wrappers until all call sites move.
3. Delete the old call sites in `execute` and `sanitizeNativeMessagesPayloadForCopilot`; the strategy now calls only `reconcileNativeMessagesPayload`.
4. Add the **new** `documentSourceReconciler` (#7) with a real-upstream matrix test — this is the only behavior change and the concrete motivator.
5. (Optional, later) wire the `nativeMessagesReconcilers` config key.

Steps 1–3 are pure refactor (green tests, no wire change). Step 4 is the bug-closing behavior change. This ordering keeps every commit independently revertable.

## When To Implement (the trigger)

Per AGENTS.md — *"Three similar lines is better than a premature helper"* and *"Fix only the issue the change targets"* — this refactor is **premature today** and is correctly deferred. Pull the trigger when **either**:

- a **7th** native reconciler is required (the document-source rule is #7 and is the natural moment), **or**
- an operator needs to toggle a native Copilot-constraint workaround without a release (config extensibility becomes load-bearing).

Until then, appending a guarded sanitizer to the strategy remains the convention-aligned choice.

## Alternatives Considered

1. **Status quo — keep appending imperative sanitizers.** Cheapest per-fix; chosen for issue #45. Fails once ordering/config/policy pressure crosses the threshold above.
2. **This proposal — declarative reconciler pipeline.** Matches the Responses precedent, makes ordering and policy explicit, unlocks config. Cost: one indirection layer for what is currently a straight-line function.
3. **Fold native reconciliation into the existing translation IR.** Route native requests through the same normalize/denormalize IR the translated paths use. Rejected: defeats the entire point of the native passthrough (zero-translation fidelity + lowest latency) and is a far larger blast radius.

## Related

- [Execution Strategy](execution-strategy.md) — where the native strategy lives
- [Messages Routing and Translation](../messages-routing-and-translation.md) — current native-path sanitizer inventory (prose)
- [`parameter-filter.ts`](../../src/transform/parameter-filter.ts) — the Responses rule-engine precedent this design mirrors
