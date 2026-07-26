#!/usr/bin/env bun

/**
 * Probe whether Copilot's native `/v1/messages` accepts `output_config.format`
 * (Anthropic structured output).
 *
 * Why this exists: the proxy routes any Messages request carrying
 * `output_config.format` away from the native path and onto the Responses
 * translator, because native Messages was believed unable to carry the schema.
 * That belief rests on a single observation from 2026-06-02 — Vertex rejecting
 * `structured_outputs` for `claude-opus-4-7` — generalized into a permanent rule
 * for every model. Models have turned over twice since. `claude-opus-5` and
 * `claude-sonnet-5` have never been tested against it, and because they do not
 * support `/responses`, the rule turns their structured-output requests into a
 * local 400 with no path that can serve them.
 *
 * Usage:
 *   bun run scripts/probes/messages/output-format.ts
 *   bun run scripts/probes/messages/output-format.ts --json
 */

import process from 'node:process'
import { modelCache } from '~/state'

import { parseProbeArgs } from '../../lib/probe-args'
import { bootstrapProbe, pickMessagesModels, probeMessagesEndpoint, runMain } from '../../lib/probe-harness'
import { statusIcon, writeJsonSnapshot } from '../../lib/probe-report'

const { jsonMode } = parseProbeArgs()

const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
}

function baseBody(modelId: string) {
  return {
    model: modelId,
    max_tokens: 64,
    stream: false,
    messages: [{ role: 'user', content: 'Reply with the word OK in the answer field.' }],
  }
}

const probes = [
  {
    label: 'baseline (no format)',
    build: (id: string) => baseBody(id),
  },
  {
    label: 'format json_schema',
    build: (id: string) => ({
      ...baseBody(id),
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    }),
  },
  {
    // The proxy's Responses translation supplies a default `name` because the
    // Responses schema requires one. Probe whether native cares either way.
    label: 'format + name',
    build: (id: string) => ({
      ...baseBody(id),
      output_config: { format: { type: 'json_schema', name: 'probe_output', schema: SCHEMA } },
    }),
  },
  {
    label: 'format + strict',
    build: (id: string) => ({
      ...baseBody(id),
      output_config: { format: { type: 'json_schema', schema: SCHEMA, strict: true } },
    }),
  },
  {
    // effort is known-good on adaptive models; pairing it with format tells us
    // whether the two coexist or whether format is rejected only in company.
    label: 'format + effort',
    build: (id: string) => ({
      ...baseBody(id),
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    }),
  },
] as const

runMain(async () => {
  await bootstrapProbe({ silent: jsonMode })

  const models = modelCache.getModels()?.data ?? []
  const messagesModels = pickMessagesModels(models)

  if (!jsonMode) {
    process.stdout.write(`\n=== output_config.format on native /v1/messages — ${messagesModels.length} model(s) ===\n\n`)
  }

  const snapshot: Array<{
    model: string
    structured_outputs: boolean
    supports_responses: boolean
    probes: Array<{ label: string, status: string, httpStatus?: number, errorMessage?: string }>
  }> = []

  for (const model of messagesModels) {
    const advertisesStructured = model.capabilities.supports.structured_outputs ?? false
    const supportsResponses = model.supported_endpoints?.includes('/responses') ?? false

    if (!jsonMode) {
      process.stdout.write(
        `--- ${model.id}  structured_outputs=${advertisesStructured}  /responses=${supportsResponses} ---\n`,
      )
    }

    const modelProbes: (typeof snapshot)[number]['probes'] = []
    for (const probe of probes) {
      const result = await probeMessagesEndpoint(probe.build(model.id))
      modelProbes.push({
        label: probe.label,
        status: result.status,
        httpStatus: result.httpStatus,
        errorMessage: result.errorMessage,
      })
      if (!jsonMode) {
        const pad = `${probe.label}:`.padEnd(24)
        process.stdout.write(
          `  ${pad} ${statusIcon(result.status)} (${result.httpStatus})${result.errorMessage ? ` — ${result.errorMessage}` : ''}\n`,
        )
      }
      await Bun.sleep(300)
    }

    snapshot.push({
      model: model.id,
      structured_outputs: advertisesStructured,
      supports_responses: supportsResponses,
      probes: modelProbes,
    })
    if (!jsonMode) {
      process.stdout.write('\n')
    }
  }

  if (jsonMode) {
    writeJsonSnapshot({ models: snapshot })
  }
})
