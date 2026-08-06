# `/responses` function-tool `strict` — schema validation by mode

What Copilot's `/responses` boundary accepts in a function tool's `parameters`,
as a function of the `strict` flag.

**Date:** 2026-08-06. **Boundary:** `/responses` only. **Method:**
`scripts/probes/tool-strict.ts` — a standing probe, re-runnable rather than
transcribed. Reproduction at the bottom.

## Why this was worth measuring

The proxy wrote `strict: tool.strict ?? true` on every function tool crossing
`/responses`, and hardcoded `strict: false` on the Anthropic→Responses path.
A caller who sent no `strict` was opted into strict validation they never
requested. To make that survivable, the shared schema normalizer rewrote every
object node's `required` to *all* declared properties and forced
`additionalProperties: false`.

Both were removed once this matrix existed. The removal is only as durable as
the evidence, hence the standing probe.

## Verdict: `strict` has three states, and absence is the safe one

| Schema shape | `strict` omitted | `strict: false` | `strict: true` |
| --- | --- | --- | --- |
| `rawClient` — metadata annotations + `$ref`/`$defs` + `anyOf` + partial `required` + `additionalProperties: true` | 200 | 200 | 400 `'additionalProperties' is required to be supplied and to be false` |
| `partialRequired` — one genuinely optional property | 200 | 200 | 400 (same) |
| `extraRequiredKey` — `required` names a key `properties` does not declare | 200 | **400** `schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the top level` | 400 `'required' is required to be supplied and to be an array including every key in properties. Extra required key 'params' supplied.` |
| `refAtRoot` — `$ref` at the schema root beside a sibling `required` | 200 | 200 | 400 |

Measured across all 10 advertised `/responses` models for the shapes above;
the table cells are identical on every model except where noted under
[Model-specific](#model-specific).

**Omitting `strict` is not the same as sending `false`.** The `extraRequiredKey`
row is the whole finding: 200 with the key absent, 400 with `strict: false`.
Upstream runs a *different validator* depending on whether the key is present at
all, so a "safe default" of `false` is not safe — it is a third behavior.

This is why both call sites now omit the key rather than defaulting it either
way.

## Acceptance is not invocation

A schema that validates has not been shown to work. The probe forces the call
with a prompt that cannot be answered without the tool, per
`../solutions/conventions/capability-verdicts-name-a-schema-and-a-mechanism.md`
— a probe whose prompt demands nothing cannot separate "declined to use" from
"unable to use".

```text
gpt-5.6-terra  strict=omitted  200  CALLED args={"city":"Paris","units":"c"}
gpt-5.3-codex  strict=omitted  200  CALLED args={"city":"Paris","units":"c"}
grok-4.5       strict=omitted  200  CALLED args={"city":"Paris"}
```

The tool is invoked, and the **optional** `units` property survives into the
emitted arguments on two of three models — which is the semantics the removed
`required` rewrite used to destroy by making `units` mandatory.

## The reported failure, before and after

The defect that started this was a client tool named `mcp__CherryHub__invoke`:

```text
Invalid schema for function 'mcp__CherryHub__invoke': In context=(), 'required'
is required to be supplied and to be an array including every key in properties.
Extra required key 'params' supplied.
```

The caller never wrote that `required` array — the proxy did, and then forced
the mode that rejected it. Replayed through the current code (normalizer applied,
no `strict` key sent), the same shape returns `200 completed` on `gpt-5.6-terra`
and `gpt-5.3-codex`.

## Model-specific

`grok-4.5` rejects `refAtRoot` under **every** `strict` value:

```text
probe_tool: tool parameter root must be an object type (root schema is a $ref)
```

That is a pre-existing upstream constraint on that model, not something this
change introduced or fixes. The old normalizer did not fix it either — a
`required` at a composition root with no sibling `properties` never triggered
the rewrite, which is precisely why the reported schema reached upstream intact.

## Metadata annotations are currently inert

`COPILOT_UNSUPPORTED_SCHEMA_ANNOTATIONS` (`$schema`, `$id`, `title`, `format`,
`default`, `example`, `examples`, `deprecated`, `readOnly`, `writeOnly`,
`contentEncoding`, `contentMediaType`) is still stripped by
`src/translator/responses/function-schema.ts`. The `rawClient` row carries every
one of them and returns 200 with `strict` omitted, so the stripping is not
currently load-bearing.

It stays anyway. That block was written against the upstream of 2026-04, and per
`../solutions/conventions/upstream-types-are-not-contract-evidence.md` a probe
result is a dated snapshot rather than a permanent fact. "Not needed today" is
not "never needed", and deleting it is maximum risk for minimum gain.

## Not covered

- **Real client tool bundles.** Claude Code's 14 tools and Codex's 5 tools,
  catalogued in `claude-5-tool-schemas.md`, were not sent. That page's own rule
  applies here: *"Single-tool passes do not prove a real client's payload
  passes."* The shapes probed here are constructed, not captured.
- **The reported CherryHub payload itself.** Only its *shape* was reconstructed
  from the upstream error text. The actual payload was never captured —
  `--dump-failed-payloads` (`src/routes/responses/strategy.ts`) writes to a
  dumps directory that does not exist on the machine where the defect was
  reported.
- **The Anthropic→Responses direction.** `convertAnthropicTools`
  (`src/translator/responses/anthropic-to-responses.ts`) routes Anthropic
  `input_schema` objects through the same normalizer, but every request here was
  sent as a native `/responses` payload with `parameters`. The schema population
  differs; the boundary is the same.
- **Streaming.** All requests were non-streaming.
- **`/v1/messages` and `/chat/completions`.** `strict` is a `/responses`
  concept; neither other boundary was probed, and per
  `../solutions/conventions/capability-verdicts-are-scoped-to-one-boundary.md`
  nothing here transfers to them.
- **Whether a large toolset degrades selection quality.** One tool per request
  throughout.

## Reproducing

```bash
bun run scripts/probes/tool-strict.ts                      # all /responses models
bun run scripts/probes/tool-strict.ts --model=gpt-5.6-terra
bun run scripts/probes/tool-strict.ts --json               # diffable snapshot
```

Re-run before changing `src/translator/responses/function-schema.ts` or either
`strict` writer (`src/routes/responses/handler.ts`,
`src/translator/responses/anthropic-to-responses.ts`).

## Related

- `../solutions/conventions/a-proxy-default-is-a-decision-made-for-the-caller.md`
  — the lesson drawn from this measurement.
- `../solutions/conventions/capability-verdicts-name-a-schema-and-a-mechanism.md`
  — why the functional case exists and why the matrix varies schema shape.
- `../solutions/conventions/upstream-types-are-not-contract-evidence.md` — why
  the inert annotation list stays.
- `scripts/probes/tool-strict.ts` — the standing probe.
