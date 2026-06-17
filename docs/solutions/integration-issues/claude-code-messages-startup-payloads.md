---
title: Claude Code Messages startup payload compatibility
date: 2026-06-02
category: integration-issues
module: Anthropic Messages routing
problem_type: integration_issue
component: tooling
symptoms:
  - "Initial /v1/messages?beta=true startup requests returned upstream 400 errors before later requests succeeded"
  - "Copilot native /v1/messages rejected anthropic-beta: mid-conversation-system-*"
  - "Vertex rejected structured_outputs when output_config.format reached Copilot native Messages"
  - "Structured output_config.format could be silently dropped while forwarding an unconstrained request"
root_cause: missing_validation
resolution_type: code_fix
severity: high
related_components:
  - "assistant"
  - "development_workflow"
tags:
  - "anthropic-messages"
  - "claude-code"
  - "structured-outputs"
  - "responses-routing"
  - "beta-headers"
  - "github-copilot"
---

# Claude Code Messages startup payload compatibility

## Problem

Newer Claude Code startup probes send Anthropic Messages payloads that exercise recently added Anthropic features before the main steady-state request path. ghc-proxy originally accepted those requests at the public Anthropic boundary but forwarded unsupported details too directly to Copilot native `/v1/messages`, causing the first startup requests to fail upstream and, in one case, risking a successful response that no longer honored the caller's structured-output contract.

## Symptoms

- Startup logs showed upstream `400 Bad Request` for `POST /v1/messages?beta=true`, followed by later successful requests.
- Vertex rejected `structured_outputs` for `claude-opus-4-7` when `output_config.format` reached Copilot native Messages.
- Copilot native Messages rejected `anthropic-beta: mid-conversation-system-2026-04-07` as an unexpected beta header.
- Review feedback later confirmed that simply stripping `output_config.format` would silently convert a schema-constrained request into an unconstrained request.

## What Didn't Work

- Passing Anthropic beta headers through unchanged did not work because Copilot native Messages does not accept every beta value that the official Anthropic API or SDK can send.
- Stripping `output_config.format` on the native path avoided the Vertex policy error, but it changed request semantics. A client using JSON Schema structured output could receive ordinary text output while believing schema constraints were still enforced.
- Letting the request fall back to Chat Completions would have the same semantic-loss problem because that path does not represent Anthropic `output_config.format`.
- Session history search found no relevant prior sessions for this specific structured-output routing problem.

## Solution

Handle the startup payloads at the proxy boundary instead of letting unsupported fields leak to Copilot native Messages.

Accept mid-conversation system messages in the Anthropic schema and translators:

```ts
const anthropicSystemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.union([
    z.string(),
    z.array(anthropicTextBlockSchema),
  ]),
}).loose()
```

Strip only the Copilot-unsupported beta values before upstream forwarding, preserving unrelated beta values:

```ts
const COPILOT_UNSUPPORTED_BETA_RE = /^mid-conversation-system-\d{4}-\d{2}-\d{2}$/

if (COPILOT_UNSUPPORTED_BETA_RE.test(value)) {
  continue
}
```

Model structured output explicitly at ingress instead of letting it pass through a loose `output_config` object:

```ts
const anthropicOutputFormatSchema = z.object({
  type: z.literal('json_schema'),
  schema: jsonObjectSchema,
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  strict: z.boolean().optional(),
}).strict()

const anthropicOutputConfigSchema = z.object({
  effort: z.enum(['low', 'medium', 'high', 'max', 'xhigh']).nullable().optional(),
  format: anthropicOutputFormatSchema.optional(),
}).strict()
```

Make Messages strategy selection payload-aware. Native Messages still wins for ordinary native-compatible payloads, but payloads with `output_config.format` need the Responses translator so the schema is preserved:

```ts
const nativeMessagesEntry: StrategyEntry<StrategyContext> = {
  name: 'native-messages',
  canHandle: (model, ctx) => modelCache.supportsEndpoint(model, MESSAGES_ENDPOINT)
    && !hasOutputConfigFormat(ctx?.anthropicPayload),
  // ...
}
```

Translate Anthropic JSON Schema output config to Responses `text.format`:

```ts
function resolveResponsesTextConfig(
  payload: AnthropicMessagesPayload,
): ResponsesPayload['text'] | undefined {
  const format = payload.output_config?.format
  if (!format) {
    return undefined
  }

  switch (format.type) {
    case 'json_schema':
      return {
        format: {
          type: 'json_schema',
          name: format.name ?? 'anthropic_output',
          schema: format.schema,
          ...(format.description !== undefined ? { description: format.description } : {}),
          ...(format.strict !== undefined ? { strict: format.strict } : {}),
        },
      }
  }
}
```

If a structured-output request reaches the Chat Completions fallback because the selected model has no `/responses` endpoint, reject it explicitly instead of silently dropping the schema:

```ts
if (hasOutputConfigFormat(ctx.anthropicPayload)) {
  throwInvalidRequestError(
    'Anthropic output_config.format requires a model with Responses endpoint support.',
    'output_config.format',
    'unsupported_output_config_format',
  )
}
```

## Why This Works

The public Anthropic boundary and the Copilot upstream boundary have different compatibility contracts. Claude Code can send newer Anthropic payload features before Copilot native Messages supports the same beta header or provider feature. Treating ghc-proxy as a translation boundary means each field must either be preserved, intentionally translated, or rejected before it reaches an incompatible upstream endpoint.

The final routing policy keeps the useful native path for ordinary Messages traffic, but diverts structured-output requests to the only current path that can preserve schema intent. When that path is unavailable, the local `400` is more correct than an upstream Vertex policy error or a successful unconstrained request.

The generated Responses schema name is also intentional. Anthropic's raw `output_config.format` example only requires `type: json_schema` and `schema`, while Responses `text.format.json_schema` requires `name`. Supplying a stable default name lets valid Anthropic structured-output requests map to valid Responses payloads without asking the caller for a Responses-specific field.

## Prevention

- Treat every newly accepted Anthropic field as a translation-policy decision: preserve it exactly, translate it losslessly, mark it lossy, or reject it explicitly.
- Do not solve upstream incompatibility by deleting caller-visible semantic fields unless the field is documented as intentionally lossy.
- Make strategy selection depend on payload semantics when endpoint support alone is not enough to preserve the request contract.
- Keep tests for both halves of a fallback decision: one test proving a supported strategy preserves the field, and one test proving unsupported strategies return local `400` before upstream dispatch.
- Keep beta-header filters narrow. Strip only known Copilot-incompatible beta values so unrelated beta behavior can continue to work.

## Related Issues

- `gh issue list --search "output_config structured output responses messages" --state all --limit 5` found no related GitHub issues.
