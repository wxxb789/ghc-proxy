# Native Messages Reconciliation Layer

> **Status: DESIGN CANDIDATE — proposed, NOT implemented.**
> This document captures a deferred refactor. No code in the current tree
> implements the reconciler pipeline.
> It exists so the systemic root cause behind issue #45 (and its siblings) is
> recorded, and so a future maintainer can pull the trigger at the right time
> against a written design instead of rediscovering it. See "When to implement"
> for the threshold that should gate the work.

## The Problem

The native `/v1/messages` strategy ([`nativeMessagesEntry`](../../src/routes/messages/strategy-registry.ts)) is a *near-passthrough*: it forwards the Anthropic payload to Copilot's `/v1/messages` with "minimal mutation". Its correctness rests on one implicit assumption:

> **Anthropic request shape ≈ Copilot-accepted shape.**

That assumption is false in a growing number of spots. Anthropic and Copilot's native endpoint disagree on specific request features, and **every disagreement not explicitly normalized leaks outward as a 400** — either from the proxy's own validator or from Copilot upstream. Issue #45 surfaced two such gaps at once; a third was found during live verification.

Today each discovered disagreement is patched with a **new, hand-wired imperative sanitizer** appended to the strategy. As of 2026-08-25, the native path performs nine reconciliation steps across the registry and strategy helpers:

| # | Sanitizer | Location | What it reconciles | Driven by |
|---|-----------|----------|--------------------|-----------|
| 1 | `convertEnabledThinkingToAdaptive` | `transform/sanitize.ts` | `thinking.enabled` → `adaptive` (+ derived `output_config.effort`) | `capabilities.supports.adaptive_thinking` |
| 2 | `filterThinkingBlocksForNativeMessages` | `transform/sanitize.ts` | Strips stale/placeholder and Responses-carrier assistant thinking blocks | block/signature shape |
| 3 | `sanitizeOutputConfig` | `transform/sanitize.ts` | Removes unsupported output config or clamps effort to advertised levels | output-config and reasoning capabilities |
| 4 | `reduceOutputFormatForNativeMessages` | `transform/sanitize.ts` | Removes the label-only structured-output `name`; semantic `description`/`strict` keep the request off native | structured-output capability + payload shape |
| 5 | `sanitizeExclusiveSamplingParams` | `transform/sanitize.ts` | Drops `top_p` when `temperature` is also present | Copilot native constraint |
| 6 | `sanitizeCacheControl` | `transform/sanitize.ts` | Removes cache-control keys other than `type` across system/messages/tools | Copilot native constraint |
| 7 | `clampMessagesOutputTokens` | `transform/parameter-filter.ts` | Lowers `max_tokens` to the model's advertised ceiling | `capabilities.limits.max_output_tokens` |
| 8 | citations strip | `strategies/native-messages.ts` | Removes the runtime-only top-level `citations` field | proxy/Copilot boundary |
| 9 | mixed `search_result` flatten | `strategies/native-messages.ts` | Flattens mixed `tool_result`/`mcp_tool_result` content to text | Copilot native constraint |

The code still has no general document-source reconciler. Ingress accepts
Anthropic-valid `document` sources such as `text`, `content`, and `file`, while
the native strategy only formats document blocks as part of a mixed
search-result tool payload. If the previously observed Copilot rejection of
those source types still reproduces, that behavior would become reconciliation
step #10.

### Symptoms of the accretion

- **No single place to reason about "what does the native path change and why".** The logic is split across `strategy-registry.ts` (seven calls) and `native-messages.ts` (two transformations, one buried in a `map`), with ordering constraints that are implicit (for example thinking conversion must run before output-config clamping).
- **Not configurable.** Copilot's native constraints shift over time (several sanitizers are explicitly marked "temporary; remove when Copilot accepts X"). There is no way to add/override a reconciliation rule without a code change and release, unlike the Responses path.
- **Silent-drop risk.** Each new field handled by hand is a chance to drop something without recording an `exact`/`lossy`/`unsupported` policy, which AGENTS.md explicitly warns against.
- **Ordering is load-bearing but undocumented.** The `execute` body's call order encodes dependencies that are invisible at the call site.

## Precedent In This Repo

The Responses boundary already solved the isomorphic problem with a **declarative, capability-driven, config-extensible rule engine**: [`parameter-filter.ts`](../../src/transform/parameter-filter.ts).

- `resolveStrippedResponsesParams(model)` composes a **built-in default rule** (any model advertising `reasoning_effort` strips `temperature`/`top_p`, minus evidence-backed per-model exemptions — codex keeps `top_p`) with **user rules** (`responsesApiParameterFilters`, glob-matched by model id), taking the **union**.
- `responsesApiParameterFiltersReplaceDefault` lets user rules fully overwrite the default.
- `applyResponsesParameterFilters(payload, model)` runs the resolved set against the payload.

The native path should adopt the same shape. The only structural difference: Responses reconciliation is homogeneous ("delete these keys"), whereas native reconciliation is **heterogeneous** (convert a shape, flatten a block, clamp a value, strip a key). So the native engine is a *pipeline of named reconcilers* rather than a *set of keys to strip*.

## The Proposed Design

### Core abstraction

```typescript
import type { AnthropicMessagesPayload } from '~/translator'
// src/transform/native-reconcile/types.ts
import type { TranslationContext } from '~/translator/anthropic/translation-policy'
import type { Model } from '~/types'

interface NativeReconcileContext {
  payload: AnthropicMessagesPayload // mutated in place
  model: Model | undefined
  translation: TranslationContext // records info/warning/error issues
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
  translation: TranslationContext,
): void {
  const ctx = { payload, model, translation }
  for (const rule of resolveNativeReconcilers(model)) {
    if (rule.appliesTo(ctx)) {
      rule.reconcile(ctx)
    }
  }
}
```

`nativeMessagesEntry.execute` plus the strategy-local sanitizer collapses from
nine scattered steps to one:

```typescript
import { TranslationContext } from '~/translator/anthropic/translation-policy'

const nativeMessagesEntry: StrategyEntry<StrategyContext> = {
  name: 'native-messages',
  canHandle: (model, ctx) => /* unchanged */ true,
  async execute(ctx) {
    const translation = new TranslationContext()
    reconcileNativeMessagesPayload(ctx.anthropicPayload, ctx.selectedModel, translation)
    const strategy = createNativeMessagesStrategy(/* ... */)
    return await runStrategy(strategy, ctx.upstreamSignal)
  },
}
```

### Rule ordering is explicit

`resolveNativeReconcilers` returns the rules in a **declared, documented order**, replacing the implicit call ordering in `execute`. Dependencies become data, not call-site trivia:

```typescript
const BUILTIN_RECONCILERS: ReadonlyArray<NativeReconciler> = [
  thinkingShapeReconciler, // 1: enabled -> adaptive (MUST precede #3)
  staleThinkingBlocksReconciler, // 2
  outputConfigReconciler, // 3: remove/clamp output config
  outputFormatReconciler, // 4: label-only reduction
  exclusiveSamplingReconciler, // 5
  cacheControlReconciler, // 6
  outputTokenLimitReconciler, // 7
  runtimeCitationsReconciler, // 8
  mixedToolResultReconciler, // 9
  documentSourceReconciler, // 10: add only if the upstream rejection still reproduces
]
```

### Capability-driven predicates

Each `appliesTo` reads model capabilities and/or evidence-backed Copilot constraints. Examples:

- `thinkingShapeReconciler.appliesTo` → `payload.thinking?.type === 'enabled' && supportsAdaptiveThinking(model)`
- `documentSourceReconciler.appliesTo` → payload has a `document` block whose `source.type ∉ {base64, url}` and the incompatibility has been reconfirmed
- `outputConfigReconciler.appliesTo` → `payload.output_config != null`

### Config extensibility (mirrors Responses)

A future `nativeMessagesReconcilers` config key can let operators add or disable rules by name/glob without a code change, exactly as `responsesApiParameterFilters` does — useful precisely because so many native rules are marked "temporary until Copilot changes". Built-in rules stay on by default; config can `disable: ["cache-control"]` once Copilot accepts `scope`, turning a code-change-and-release into a config toggle.

### Policy recording

Every reconciler that loses information calls `TranslationContext.record()`
with an explicit issue (`lossy_*` / `unsupported_*`) instead of silently
mutating. Exact or diagnostic events may use `info`; lossy changes use
`warning`; an unrepresentable caller guarantee uses `error` and the existing
strict-policy behavior. Mixed-tool-result flattening and any future document
flattening are lossy. Thinking-shape conversion is semantically equivalent at
the API level, while bucketing `budget_tokens` into an effort level is lossy.

## Migration Plan (incremental, behavior-preserving, non-breaking)

1. Introduce `src/transform/native-reconcile/` (types + runner + empty registry). No behavior change.
2. Port the nine existing reconciliation steps **one at a time**, each behind its existing tests, asserting byte-identical forwarded payloads via the `mockMessages` capture harness (`tests/messages-routing.test.ts`). Keep the old functions as thin wrappers until all call sites move.
3. Delete the old call sites in `execute` and `sanitizeNativeMessagesPayloadForCopilot`; the strategy now calls only `reconcileNativeMessagesPayload`.
4. Re-run the document-source upstream probe. If the incompatibility remains, add `documentSourceReconciler` as step #10 with a real-upstream matrix test; this is the only behavior change.
5. (Optional, later) wire the `nativeMessagesReconcilers` config key.

Steps 1–3 are pure refactor (green tests, no wire change). Step 4 is the bug-closing behavior change. This ordering keeps every commit independently revertable.

## When To Implement (the trigger)

The number of current sanitizers is not by itself a reason to add a framework.
Keep fixes local while the straight-line native path remains understandable.
Introduce this layer only when a real repeated-ordering defect appears, or when
an operator must toggle independent native Copilot workarounds without a
release. The document-source rule remains a candidate to probe, not an automatic
trigger for the abstraction.

## Alternatives Considered

1. **Status quo — keep appending imperative sanitizers.** This is the current implementation and remains cheapest while ordering and ownership stay understandable.
2. **This proposal — declarative reconciler pipeline.** Matches the Responses precedent, makes ordering and policy explicit, unlocks config. Cost: one indirection layer for what is currently a straight-line function.
3. **Fold native reconciliation into the existing translation IR.** Route native requests through the same normalize/denormalize IR the translated paths use. Rejected: defeats the entire point of the native passthrough (zero-translation fidelity + lowest latency) and is a far larger blast radius.

## Related

- [Execution Strategy](execution-strategy.md) — where the native strategy lives
- [Messages Routing and Translation](../messages-routing-and-translation.md) — current native-path sanitizer inventory (prose)
- [`parameter-filter.ts`](../../src/transform/parameter-filter.ts) — the Responses rule-engine precedent this design mirrors
