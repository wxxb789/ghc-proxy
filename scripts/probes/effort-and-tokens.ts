#!/usr/bin/env bun

/**
 * Probe reasoning-effort levels and output-token parameters per model.
 *
 * Three questions this answers, none of which can be settled from the model
 * record alone:
 *
 * 1. Does a model actually accept every effort level it advertises in
 *    `capabilities.supports.reasoning_effort` — and does it reject the ones it
 *    does not advertise? The proxy currently downgrades Anthropic `max` to
 *    `xhigh` on the Responses path, which predates gpt-5.6 advertising `max`.
 *
 * 2. Which output-token parameter does each boundary want? Probing
 *    /chat/completions surfaced `Unsupported parameter: 'max_tokens' is not
 *    supported with this model. Use 'max_completion_tokens' instead.` for
 *    gpt-5.4, so the two are not interchangeable.
 *
 * 3. Are there per-model min/max bounds on those token parameters, beyond the
 *    advertised `limits.max_output_tokens`?
 *
 * Usage:
 *   bun run scripts/probes/effort-and-tokens.ts
 *   bun run scripts/probes/effort-and-tokens.ts --json
 */

import type { Model } from '~/types'

import process from 'node:process'
import { MESSAGES_ENDPOINT, modelCache, RESPONSES_ENDPOINT } from '~/state'

import { parseProbeArgs } from '../lib/probe-args'
import {
  bootstrapProbe,
  CHAT_COMPLETIONS_ENDPOINT,
  probeChatCompletionsEndpoint,
  probeMessagesEndpoint,
  probeResponsesEndpoint,
  runMain,
} from '../lib/probe-harness'
import { statusIcon, writeJsonSnapshot } from '../lib/probe-report'

const { jsonMode } = parseProbeArgs()

const PROMPT = 'Reply OK.'

/** Every level any model advertises today, plus the two the proxy can emit. */
const ALL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function isReasoning(model: Model): boolean {
  return (model.capabilities.supports.reasoning_effort?.length ?? 0) > 0
}

function advertises(model: Model, effort: string): boolean {
  return model.capabilities.supports.reasoning_effort?.includes(effort) ?? false
}

// ── Effort probes, per boundary ──

function messagesEffortBody(modelId: string, effort: string): Record<string, unknown> {
  return {
    model: modelId,
    max_tokens: 32,
    stream: false,
    messages: [{ role: 'user', content: PROMPT }],
    output_config: { effort },
  }
}

function chatEffortBody(modelId: string, effort: string): Record<string, unknown> {
  return {
    model: modelId,
    max_tokens: 32,
    stream: false,
    messages: [{ role: 'user', content: PROMPT }],
    reasoning_effort: effort,
  }
}

function responsesEffortBody(modelId: string, effort: string): Record<string, unknown> {
  return {
    model: modelId,
    max_output_tokens: 1024,
    stream: false,
    store: false,
    input: [{ type: 'message', role: 'user', content: PROMPT }],
    reasoning: { effort },
  }
}

// ── Token-parameter probes ──
//
// Bounds are probed with values chosen to bracket the plausible range: 0 and 1
// catch a minimum, the advertised limit confirms the ceiling is honoured, and
// limit+1 checks whether it is enforced or silently clamped.

function tokenVariants(model: Model, key: string): Array<{ label: string, value: number }> {
  const max = model.capabilities.limits.max_output_tokens
  return [
    { label: `${key}=0`, value: 0 },
    { label: `${key}=1`, value: 1 },
    { label: `${key}=16`, value: 16 },
    ...(max ? [{ label: `${key}=max(${max})`, value: max }] : []),
    ...(max ? [{ label: `${key}=max+1`, value: max + 1 }] : []),
  ]
}

runMain(async () => {
  await bootstrapProbe({ silent: jsonMode })

  const models = modelCache.getModels()?.data ?? []
  const rows: Array<Record<string, unknown>> = []

  // ═══ Part 1: reasoning effort ═══

  const effortBoundaries = [
    {
      name: 'messages',
      endpoint: MESSAGES_ENDPOINT,
      build: messagesEffortBody,
      send: probeMessagesEndpoint,
    },
    {
      name: 'chat/completions',
      endpoint: CHAT_COMPLETIONS_ENDPOINT,
      build: chatEffortBody,
      send: probeChatCompletionsEndpoint,
    },
    {
      name: 'responses',
      endpoint: RESPONSES_ENDPOINT,
      build: responsesEffortBody,
      send: probeResponsesEndpoint,
    },
  ]

  for (const boundary of effortBoundaries) {
    const eligible = models.filter(
      m => m.supported_endpoints?.includes(boundary.endpoint) && isReasoning(m),
    )

    if (!jsonMode) {
      process.stdout.write(
        `\n════ EFFORT · ${boundary.endpoint} — ${eligible.length} reasoning model(s) ════\n\n`,
      )
    }

    for (const model of eligible) {
      const advertised = model.capabilities.supports.reasoning_effort ?? []

      if (!jsonMode) {
        process.stdout.write(`--- ${model.id}  advertises ${JSON.stringify(advertised)} ---\n`)
      }

      const results: Record<string, unknown> = {}

      for (const effort of ALL_EFFORTS) {
        const result = await boundary.send(boundary.build(model.id, effort))
        const claimed = advertises(model, effort)

        results[effort] = {
          advertised: claimed,
          status: result.status,
          httpStatus: result.httpStatus,
          note: result.note,
        }

        if (!jsonMode) {
          // Flag disagreements between what the model claims and what it does.
          const accepted = result.status === 'accepted'
          const mismatch = accepted !== claimed ? '  ← MISMATCH' : ''
          process.stdout.write(
            `  ${statusIcon(result.status)} ${effort.padEnd(8)} `
            + `${claimed ? 'advertised' : '    —     '} `
            + `${String(result.httpStatus ?? '-').padEnd(5)} `
            + `${(result.note ?? '').slice(0, 90)}${mismatch}\n`,
          )
        }
      }

      rows.push({ part: 'effort', boundary: boundary.name, model: model.id, advertised, results })

      if (!jsonMode) {
        process.stdout.write('\n')
      }
    }
  }

  // ═══ Part 2: output-token parameters ═══

  const tokenBoundaries = [
    {
      name: 'chat/completions',
      endpoint: CHAT_COMPLETIONS_ENDPOINT,
      keys: ['max_tokens', 'max_completion_tokens'],
      base: (id: string) => ({
        model: id,
        stream: false,
        messages: [{ role: 'user', content: PROMPT }],
      }),
      send: probeChatCompletionsEndpoint,
    },
    {
      name: 'messages',
      endpoint: MESSAGES_ENDPOINT,
      keys: ['max_tokens', 'max_completion_tokens'],
      base: (id: string) => ({
        model: id,
        stream: false,
        messages: [{ role: 'user', content: PROMPT }],
      }),
      send: probeMessagesEndpoint,
    },
    {
      name: 'responses',
      endpoint: RESPONSES_ENDPOINT,
      keys: ['max_output_tokens', 'max_tokens'],
      base: (id: string) => ({
        model: id,
        stream: false,
        store: false,
        input: [{ type: 'message', role: 'user', content: PROMPT }],
      }),
      send: probeResponsesEndpoint,
    },
  ]

  for (const boundary of tokenBoundaries) {
    const eligible = models.filter(m => m.supported_endpoints?.includes(boundary.endpoint))

    if (!jsonMode) {
      process.stdout.write(
        `\n════ TOKENS · ${boundary.endpoint} — ${eligible.length} model(s) ════\n\n`,
      )
    }

    for (const model of eligible) {
      if (!jsonMode) {
        process.stdout.write(
          `--- ${model.id}  limits.max_output_tokens=${model.capabilities.limits.max_output_tokens ?? '-'} ---\n`,
        )
      }

      const results: Record<string, unknown> = {}

      for (const key of boundary.keys) {
        for (const variant of tokenVariants(model, key)) {
          const body = { ...boundary.base(model.id), [key]: variant.value }
          const result = await boundary.send(body)

          results[variant.label] = {
            status: result.status,
            httpStatus: result.httpStatus,
            note: result.note,
          }

          if (!jsonMode) {
            process.stdout.write(
              `  ${statusIcon(result.status)} ${variant.label.padEnd(28)} `
              + `${String(result.httpStatus ?? '-').padEnd(5)} ${(result.note ?? '').slice(0, 90)}\n`,
            )
          }
        }
      }

      rows.push({
        part: 'tokens',
        boundary: boundary.name,
        model: model.id,
        advertisedMaxOutput: model.capabilities.limits.max_output_tokens,
        results,
      })

      if (!jsonMode) {
        process.stdout.write('\n')
      }
    }
  }

  if (jsonMode) {
    writeJsonSnapshot({ probe: 'effort-and-tokens', rows })
  }
})
