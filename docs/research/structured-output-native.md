# Structured output on native `/v1/messages` (probed)

Whether Copilot's native Messages endpoint accepts Anthropic
`output_config.format`, and in what shape.

**Probe:** `scripts/probes/messages/output-format.ts` — re-run it when models
change. **Date:** 2026-07-26. **Method:** minimal non-streaming request per
variant, sent directly to the upstream endpoint (no proxy in the path).

## Summary

**Native Messages serves structured output.** 6 of 8 Messages models returned
200 for a bare `{ type: 'json_schema', schema }`. The proxy had been routing
every such request away from the native path on the assumption that it could
not.

| Model | `structured_outputs` | bare format | verdict |
| --- | --- | --- | --- |
| `claude-opus-5` | true | ✅ 200 | serves natively |
| `claude-sonnet-5` | true | ✅ 200 | serves natively |
| `claude-opus-4.8` | true | ✅ 200 | serves natively |
| `claude-opus-4.6` | true | ✅ 200 | serves natively |
| `claude-sonnet-4.5` | **false** | ✅ 200 | accepts it unadvertised |
| `claude-haiku-4.5` | **false** | ✅ 200 | accepts it unadvertised |
| `claude-opus-4.7` | true | ❌ 400 | Vertex org policy |
| `claude-sonnet-4.6` | true | ❌ 400 | Vertex org policy |

## What this corrected

The proxy routed any Messages payload carrying `output_config.format` to the
Responses translator, and rejected it outright when the model had no
`/responses` endpoint. That rule came from a single 2026-06-02 observation —
Vertex refusing `structured_outputs` for `claude-opus-4-7` — generalized into a
permanent rule for every model.

`claude-opus-4.7` turns out to be the minority case, and its failure is not a
protocol limit at all:

```
Organization Policy constraint constraints/vertexai.allowedPartnerModelFeatures
violated ... attempting to use a disallowed feature structured_outputs for
Partner model claude-opus-4-7
```

That is a Google Cloud project policy on the Vertex-served models, not a
statement about Anthropic Messages. `claude-sonnet-4.6` fails the same way —
consistent with it being Bedrock/Vertex-served, as
`sampling-parameters.md` already noted for other features.

Meanwhile `claude-opus-5` and `claude-sonnet-5` have no `/responses` endpoint,
so the rule left their structured-output requests with **no path at all** — a
local 400 with `unsupported_output_config_format`.

## The accepted shape is narrower than Anthropic's

Native accepts `type` and `schema` only. The optional Anthropic annotations are
rejected:

```
output_config.format.name: Extra inputs are not permitted
output_config.format.strict: Extra inputs are not permitted
```

This matters because the Responses translation does the opposite — Responses
`text.format.json_schema` *requires* `name`, so the translator injects a default
one. The two paths need different payload shapes for the same caller request.

`format` also coexists with `effort` where the model supports both: the
`format + effort` variant returned 200 on every model whose baseline passed.

## Resulting proxy behavior

| Caller sends | Path |
| --- | --- |
| `{ type, schema }`, model advertises `structured_outputs` | native, forwarded as-is |
| `+ name` / `+ description` | native, labels stripped |
| `+ strict` | **not** native — the guarantee cannot be dropped silently |
| model does not advertise `structured_outputs` | Responses, else explicit 400 |
| `claude-opus-4.7`, `claude-sonnet-4.6` | Responses, else explicit 400 — excluded by ID |

The last row is the one the advertised capability cannot express: both models
advertise `structured_outputs: true` and are stopped only by the GCP policy, so
routing on the flag alone would send them to a path that 400s upstream.
`MODELS_BLOCKING_NATIVE_STRUCTURED_OUTPUT` (`src/state/model-cache.ts`) carries
them as a dated ID list, the same shape `MODELS_REJECTING_OUTPUT_CONFIG` uses —
a policy exclusion written down as a policy exclusion, and bounded in time so
re-running this probe can retire it.

`strict` is treated as a caller guarantee rather than an annotation: it promises
the reply conforms to the schema. Stripping it to fit the native shape would
hand back an unconstrained answer while the caller believes the constraint
applied — the failure mode
`docs/solutions/integration-issues/claude-code-messages-startup-payloads.md`
documents. Those requests keep their existing routing.

The two unadvertised acceptances (`claude-sonnet-4.5`, `claude-haiku-4.5`) are
**not** exploited. They are the same asymmetry recorded in
`sampling-parameters.md` for `gpt-5.3-codex` and `none`: the advertised list is
a floor on capability, so routing on it stays safe, while routing on observed
behavior would bind the proxy to an undocumented quirk.

## Not covered

- Whether the schema is actually enforced in the reply. The probe asserts
  acceptance, not that output conforms.
- Streaming requests. All probes were non-streaming.
- Whether the Vertex policy blocking `claude-opus-4.7` and `claude-sonnet-4.6`
  is account-specific. It names a specific GCP project, so another Copilot
  account may see different results — re-run the probe rather than assuming
  these two models are permanently excluded.
