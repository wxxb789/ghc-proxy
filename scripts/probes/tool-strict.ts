#!/usr/bin/env bun

/**
 * Probe how Copilot's `/responses` boundary validates function-tool schemas as
 * a function of the `strict` flag.
 *
 * The proxy used to force `strict: true` onto every function tool the caller
 * did not mark, and rewrite each object node's `required` array to every
 * declared property plus `additionalProperties: false` so the forced mode would
 * survive. Both were removed once this matrix was measured; this probe is what
 * keeps that removal honest.
 *
 * Two findings are load-bearing and easy to lose:
 *
 * 1. **`strict` has three states, not two.** Omitting the key is not the same
 *    as sending `false` — upstream runs a different validator when the key is
 *    present at all. A schema whose `required` names a key absent from
 *    `properties` returns 200 with the key omitted and 400 with `strict: false`.
 * 2. **Acceptance is not invocation.** A schema can validate and still never be
 *    called, so the matrix alone cannot say the tool works. The functional case
 *    forces the call with a prompt that cannot be answered without it.
 *
 * Re-run this before changing anything in
 * `src/translator/responses/function-schema.ts` or either `strict` writer
 * (`src/routes/responses/handler.ts`, `src/translator/responses/anthropic-to-responses.ts`).
 *
 * Usage:
 *   bun run scripts/probes/tool-strict.ts
 *   bun run scripts/probes/tool-strict.ts --json
 *   bun run scripts/probes/tool-strict.ts --model=gpt-5.6-terra
 */

import process from 'node:process'
import { modelCache, RESPONSES_ENDPOINT } from '~/state'

import { parseProbeArgs } from '../lib/probe-args'
import {
  bootstrapProbe,
  pickModelById,
  pickResponsesModels,
  probeResponsesEndpoint,
  runMain,
  sendRawWithRetry,
} from '../lib/probe-harness'
import { printBanner, statusIcon, writeJsonSnapshot } from '../lib/probe-report'

const { jsonMode, requestedModelId } = parseProbeArgs()

const PROMPT = 'Reply OK.'
const TOOL_NAME = 'probe_tool'

// ── Schema shapes ──
//
// Each shape isolates one property of a real client schema that the removed
// rewrite used to paper over. `rawClient` is the composite: it carries every
// metadata annotation the proxy still strips, plus composition, a partial
// `required`, and an open `additionalProperties`.

const SCHEMA_SHAPES = [
  {
    label: 'rawClient',
    note: 'metadata + $ref/$defs + anyOf + partial required + additionalProperties:true',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.invalid/probe.json',
      title: 'probe arguments',
      type: 'object',
      properties: {
        server: { type: 'string', description: 'server name' },
        url: { type: 'string', format: 'uri', examples: ['https://example.invalid'] },
        count: { type: 'integer', default: 10, deprecated: false },
        blob: { type: 'string', contentEncoding: 'base64', contentMediaType: 'image/png' },
        mode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        params: { $ref: '#/$defs/Params' },
      },
      required: ['server'],
      $defs: {
        Params: { type: 'object', additionalProperties: true },
      },
    },
  },
  {
    label: 'partialRequired',
    note: 'a genuinely optional property — the rewrite used to promote it to required',
    schema: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        units: { type: 'string' },
      },
      required: ['city'],
    },
  },
  {
    label: 'extraRequiredKey',
    note: 'required names a key properties does not declare — the reported CherryHub shape',
    schema: {
      type: 'object',
      properties: { server: { type: 'string' } },
      required: ['server', 'params'],
      additionalProperties: false,
    },
  },
  {
    label: 'refAtRoot',
    note: 'composition at the schema root — the rewrite could never reach this required',
    schema: {
      $ref: '#/$defs/Invoke',
      required: ['params'],
      $defs: {
        Invoke: { type: 'object', properties: { params: { type: 'string' } } },
      },
    },
  },
] as const

/**
 * `undefined` means the key is absent from the payload entirely. It is a
 * distinct third state, not a synonym for `false`.
 */
const STRICT_VALUES = [undefined, false, true] as const

function strictLabel(value: boolean | undefined): string {
  return value === undefined ? 'omitted' : String(value)
}

function buildBody(
  modelId: string,
  schema: Record<string, unknown>,
  strict: boolean | undefined,
): Record<string, unknown> {
  return {
    model: modelId,
    max_output_tokens: 32,
    stream: false,
    store: false,
    input: [{ type: 'message', role: 'user', content: PROMPT }],
    tools: [{
      type: 'function',
      name: TOOL_NAME,
      description: 'Probe tool',
      parameters: schema,
      ...(strict === undefined ? {} : { strict }),
    }],
  }
}

// ── Functional case ──
//
// A schema that validates has not been shown to work. This forces the call with
// a prompt that cannot be satisfied without the tool, then checks the emitted
// arguments — including whether the *optional* property survived, which is the
// semantics the removed rewrite used to destroy.

const FUNCTIONAL_SCHEMA = {
  type: 'object',
  properties: {
    city: { type: 'string', description: 'City name' },
    units: { type: 'string', enum: ['c', 'f'], description: 'Optional units' },
  },
  required: ['city'],
}

interface FunctionalOutcome {
  httpStatus: number
  called: boolean
  arguments?: string
  error?: string
}

async function probeFunctional(
  modelId: string,
  strict: boolean | undefined,
): Promise<FunctionalOutcome> {
  const { httpStatus, parsed } = await sendRawWithRetry({
    model: modelId,
    max_output_tokens: 2048,
    stream: false,
    store: false,
    input: [{
      type: 'message',
      role: 'user',
      content: 'What is the weather in Paris? Use the get_weather tool.',
    }],
    tool_choice: { type: 'function', name: 'get_weather' },
    tools: [{
      type: 'function',
      name: 'get_weather',
      description: 'Get the weather for a city',
      parameters: FUNCTIONAL_SCHEMA,
      ...(strict === undefined ? {} : { strict }),
    }],
  }, { endpoint: RESPONSES_ENDPOINT })

  const record = parsed as { output?: Array<Record<string, unknown>>, error?: { message?: string } } | null
  const call = Array.isArray(record?.output)
    ? record.output.find(item => item.type === 'function_call')
    : undefined

  return {
    httpStatus,
    called: call !== undefined,
    ...(typeof call?.arguments === 'string' ? { arguments: call.arguments } : {}),
    ...(record?.error?.message ? { error: record.error.message } : {}),
  }
}

runMain(async () => {
  await bootstrapProbe({ silent: jsonMode })

  const all = modelCache.getModels()?.data ?? []
  const models = requestedModelId
    ? [pickModelById(all, requestedModelId)].filter(model => model !== undefined)
    : pickResponsesModels(all)

  if (models.length === 0) {
    throw new Error(
      requestedModelId
        ? `Model ${requestedModelId} not found or does not advertise ${RESPONSES_ENDPOINT}`
        : `No model advertises ${RESPONSES_ENDPOINT}`,
    )
  }

  if (!jsonMode) {
    printBanner(`/responses function-tool strict matrix — ${models.length} model(s)`)
  }

  const rows: Array<Record<string, unknown>> = []

  for (const model of models) {
    if (!jsonMode) {
      process.stdout.write(`\n--- ${model.id} ---\n`)
    }

    const results: Record<string, Record<string, unknown>> = {}

    for (const shape of SCHEMA_SHAPES) {
      const perStrict: Record<string, unknown> = {}

      for (const strict of STRICT_VALUES) {
        const base = buildBody(model.id, shape.schema as Record<string, unknown>, undefined)
        const body = buildBody(model.id, shape.schema as Record<string, unknown>, strict)
        const result = await probeResponsesEndpoint(body, base)

        perStrict[strictLabel(strict)] = {
          status: result.status,
          httpStatus: result.httpStatus,
          note: result.note,
        }

        if (!jsonMode) {
          process.stdout.write(
            `  ${statusIcon(result.status)} ${shape.label.padEnd(17)} `
            + `strict=${strictLabel(strict).padEnd(9)} `
            + `${String(result.httpStatus ?? '-').padEnd(5)} ${(result.note ?? '').slice(0, 100)}\n`,
          )
        }
      }

      results[shape.label] = perStrict
    }

    // Functional: schema acceptance is not tool invocation.
    const functional: Record<string, unknown> = {}
    for (const strict of STRICT_VALUES) {
      const outcome = await probeFunctional(model.id, strict)
      functional[strictLabel(strict)] = outcome

      if (!jsonMode) {
        const summary = outcome.called
          ? `CALLED args=${outcome.arguments ?? '-'}`
          : outcome.error ?? 'no call'
        process.stdout.write(
          `  ${outcome.called ? '✓' : '✗'} ${'functional'.padEnd(17)} `
          + `strict=${strictLabel(strict).padEnd(9)} `
          + `${String(outcome.httpStatus).padEnd(5)} ${summary.slice(0, 100)}\n`,
        )
      }
    }

    rows.push({
      model: model.id,
      vendor: model.vendor,
      shapes: results,
      functional,
    })
  }

  if (jsonMode) {
    writeJsonSnapshot({
      probe: 'tool-strict',
      endpoint: RESPONSES_ENDPOINT,
      shapes: SCHEMA_SHAPES.map(shape => ({ label: shape.label, note: shape.note })),
      rows,
    })
  }
})
