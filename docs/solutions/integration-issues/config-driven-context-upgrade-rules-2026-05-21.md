---
title: Config-driven context upgrade rules for long-context Copilot models
date: 2026-05-21
category: integration-issues
module: model routing and context upgrade
problem_type: integration_issue
component: tooling
symptoms:
  - "Long /v1/messages requests returned upstream 400 model_max_prompt_tokens_exceeded"
  - "Configured enterprise longer-context models were not used during context-length failures"
  - "anthropic-beta context-* requests could still route without the intended longer-context target"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - "development_workflow"
  - "assistant"
tags:
  - "context-upgrade"
  - "model-routing"
  - "github-copilot"
  - "anthropic-messages"
  - "config-driven-routing"
  - "long-context"
  - "enterprise-models"
---

# Config-driven context upgrade rules for long-context Copilot models

## Problem

A long `/v1/messages` request failed with an upstream Copilot context-length error even though the account had access to a longer-context model. The proxy sent the request through the normal model path and hit the standard Opus prompt limit instead of upgrading to the configured long-context target.

The observed upstream error was:

```text
prompt token count of 203270 exceeds the limit of 168000
code: model_max_prompt_tokens_exceeded
```

## Symptoms

- `/v1/messages` requests could fail with `400 model_max_prompt_tokens_exceeded` under high prompt token counts.
- A user-owned enterprise model such as `claude-opus-4.7-1m-internal` was not selected automatically during context pressure.
- Claude-family requests could unexpectedly end up on the `/chat/completions` path or a normal-context model limit instead of preserving native Messages routing.
- `anthropic-beta: context-*` handling could strip the beta header without making the configured long-context target visible in the request mapping trace.

## What Didn't Work

- Hardcoding `claude-opus-4.7-1m-internal` would fix one enterprise account but break the portability contract for users who cannot access that private or rollout model.
- Keeping a built-in source-code rule such as `claude-opus-4.6 -> claude-opus-4.6-1m` did not cover account-specific model availability or future model names.
- Requiring the upgrade target to appear in Copilot's `/models` response was too strict. Internal rollout models can be available for inference while catalog responses are delayed, inconsistent, or account-specific.
- Fixing only reactive retry was incomplete because the same context-upgrade decision must apply to proactive token estimation and `anthropic-beta: context-*` requests.
- The beta-header path initially upgraded the model without emitting a `BETA_UPGRADE` trace tag, which made live verification and future debugging harder.

Session history search found no relevant prior sessions for this specific problem.

## Solution

Make context upgrades config-driven and apply the same rules across all context-pressure signals.

Expose `contextUpgradeRules` in config:

```ts
contextUpgradeRules: z.array(z.object({
  from: z.string(),
  to: z.string(),
})).optional()
```

Expose the cached config through `ConfigStore`:

```ts
class ConfigStore {
  getContextUpgradeRules(): Array<{ from: string, to: string }> {
    return getCachedConfig().contextUpgradeRules ?? []
  }
}
```

Resolve upgrades from user config instead of source-code constants:

```ts
export function hasContextUpgradeRule(model: string): boolean {
  return configStore.getContextUpgradeRules().some(rule => matchesGlob(rule.from, model))
}
```

Configured targets are trusted even when the target is not currently in the model cache:

```ts
return {
  from: rule.from,
  to: normalizeToKnownModel(rule.to) ?? rule.to,
}
```

Preserve original model metadata when an upgraded target lacks catalog metadata, so `/v1/messages` can keep the native Messages strategy:

```ts
resolvedModel: modelCache.findById(result.upgradeTarget)
  ?? resolvedModel
  ?? modelCache.findById(model)
```

Apply the same fallback in reactive retry:

```ts
const currentModel = isRetry
  ? modelCache.findById(model) ?? selectedModel
  : selectedModel
```

Users with enterprise access can opt into their long-context model in `config.json`:

```json
{
  "modelRewrites": [
    { "from": "claude-opus-*", "to": "claude-opus-4.7" }
  ],
  "contextUpgrade": true,
  "contextUpgradeRules": [
    { "from": "claude-opus-4.7", "to": "claude-opus-4.7-1m-internal" }
  ],
  "contextUpgradeTokenThreshold": 160000
}
```

The final live smoke against an isolated debug server showed the intended mapping. Because the configured target was present in the model cache during this run, the strategy log also showed the upgraded target:

```text
Strategy selected: native-messages for model: claude-opus-4.7-1m-internal
model=claude-opus-4.7 -[CONFIG_REWRITE]-> claude-opus-4.7 -[BETA_UPGRADE]-> claude-opus-4.7-1m-internal
```

## Why This Works

Context model availability is account-specific. Public models, enterprise-only models, and internal rollout models vary by account, region, and feature flag. Moving upgrade targets into config lets each user opt into the models they can actually call without forcing private identifiers into the default behavior.

Using one rule source also keeps the three context-upgrade paths consistent:

- proactive token-estimation upgrade before dispatch
- `anthropic-beta: context-*` upgrade for Anthropic-compatible clients
- reactive retry after upstream context-length errors

Preserving original selected model metadata prevents a configured internal target from degrading route selection when the target is missing from `/models`. If the source model supports native `/v1/messages`, the upgraded request can still use that strategy instead of falling back to `/chat/completions`.

## Prevention

- Keep account-specific, private, rollout, regional, or organization-gated model IDs in config rather than source-code defaults.
- Keep `contextUpgradeRules` as the single source of truth and reuse the existing context-upgrade lookup helpers across proactive handling, beta-header handling, and retry recovery.
- Do not make explicit user config depend on transient catalog presence unless the upstream contract guarantees catalog consistency.
- Preserve source model metadata when a configured target has no cache entry but should inherit the same protocol strategy.
- Add request mapping trace tags for each transform so live verification can show exactly why a model changed.
- Cover context upgrade behavior with tests for proactive upgrade, beta-header upgrade, and context-length retry.

## Related Issues

- Related solution: `docs/solutions/integration-issues/claude-code-messages-startup-payloads.md` covers a different `/v1/messages` strategy-selection problem around structured-output preservation and beta-header filtering. Overlap is moderate: same routing layer and endpoint family, different root cause and prevention rule.
- `gh issue list` did not find related GitHub issues for model routing, context upgrade, model rewrites, `/v1/messages`, or beta-header queries.
