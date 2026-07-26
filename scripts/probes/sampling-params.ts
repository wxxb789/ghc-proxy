#!/usr/bin/env bun

/**
 * Probe sampling-parameter acceptance across ALL THREE upstream boundaries.
 *
 * The proxy has treated `top_k` as unsupported since the original translator
 * (#5/#6) — dropped on the chat-completions fallback, rejected with 400 on the
 * Responses path — but that policy was never probed. `top_k` is also absent
 * from our own upstream payload types, which proves only that we never
 * modelled it.
 *
 * `parameter-filter` separately strips `temperature`/`top_p` for reasoning
 * models on the Responses boundary. That rule was derived from a real 400, but
 * only for that one boundary.
 *
 * This establishes, per boundary and per model, which of
 * `temperature` / `top_p` / `top_k` are actually accepted — and whether any
 * combination is rejected even when each is fine alone.
 *
 * Usage:
 *   bun run scripts/probes/sampling-params.ts
 *   bun run scripts/probes/sampling-params.ts --json
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

// ── Per-boundary request shapes ──

function messagesBase(modelId: string): Record<string, unknown> {
  return {
    model: modelId,
    max_tokens: 32,
    stream: false,
    messages: [{ role: 'user', content: PROMPT }],
  }
}

function chatBase(modelId: string): Record<string, unknown> {
  return {
    model: modelId,
    max_tokens: 32,
    stream: false,
    messages: [{ role: 'user', content: PROMPT }],
  }
}

function responsesBase(modelId: string): Record<string, unknown> {
  return {
    model: modelId,
    max_output_tokens: 32,
    stream: false,
    store: false,
    input: [{ type: 'message', role: 'user', content: PROMPT }],
  }
}

interface Boundary {
  name: string
  endpoint: string
  base: (modelId: string) => Record<string, unknown>
  send: (
    body: Record<string, unknown>,
    base: Record<string, unknown>,
  ) => ReturnType<typeof probeMessagesEndpoint>
}

const BOUNDARIES: Array<Boundary> = [
  {
    name: 'messages',
    endpoint: MESSAGES_ENDPOINT,
    base: messagesBase,
    send: probeMessagesEndpoint,
  },
  {
    name: 'chat/completions',
    endpoint: CHAT_COMPLETIONS_ENDPOINT,
    base: chatBase,
    send: probeChatCompletionsEndpoint,
  },
  {
    name: 'responses',
    endpoint: RESPONSES_ENDPOINT,
    base: responsesBase,
    send: probeResponsesEndpoint,
  },
]

// ── Parameter variants ──
//
// `top_k` is probed alone AND alongside the params the proxy already allows,
// because a param can be accepted in isolation yet rejected in combination —
// which is exactly what the messages boundary turned out to do for
// temperature+top_p.

const VARIANTS = [
  { label: 'baseline', params: {} },
  { label: 'temperature=0.5', params: { temperature: 0.5 } },
  { label: 'top_p=0.9', params: { top_p: 0.9 } },
  { label: 'top_k=40', params: { top_k: 40 } },
  { label: 'temperature+top_p', params: { temperature: 0.5, top_p: 0.9 } },
  { label: 'top_k+top_p', params: { top_k: 40, top_p: 0.9 } },
  { label: 'top_k+temperature', params: { top_k: 40, temperature: 0.5 } },
  { label: 'all three', params: { temperature: 0.5, top_p: 0.9, top_k: 40 } },
] as const

function isReasoning(model: Model): boolean {
  return (model.capabilities.supports.reasoning_effort?.length ?? 0) > 0
}

runMain(async () => {
  await bootstrapProbe({ silent: jsonMode })

  const models = modelCache.getModels()?.data ?? []
  const rows: Array<Record<string, unknown>> = []

  for (const boundary of BOUNDARIES) {
    const eligible = models.filter(m => m.supported_endpoints?.includes(boundary.endpoint))

    if (!jsonMode) {
      process.stdout.write(
        `\n════ ${boundary.endpoint} — ${eligible.length} model(s) ════\n\n`,
      )
    }

    for (const model of eligible) {
      const kind = isReasoning(model) ? 'reasoning' : 'non-reasoning'

      if (!jsonMode) {
        process.stdout.write(`--- ${model.id} (${kind}) ---\n`)
      }

      const results: Record<string, unknown> = {}

      for (const variant of VARIANTS) {
        const base = boundary.base(model.id)
        const body = { ...base, ...variant.params }
        const result = await boundary.send(body, base)

        results[variant.label] = {
          status: result.status,
          httpStatus: result.httpStatus,
          note: result.note,
        }

        if (!jsonMode) {
          process.stdout.write(
            `  ${statusIcon(result.status)} ${variant.label.padEnd(18)} `
            + `${String(result.httpStatus ?? '-').padEnd(5)} ${result.note ?? ''}\n`,
          )
        }
      }

      rows.push({
        boundary: boundary.name,
        endpoint: boundary.endpoint,
        model: model.id,
        kind,
        vendor: model.vendor,
        results,
      })

      if (!jsonMode) {
        process.stdout.write('\n')
      }
    }
  }

  if (jsonMode) {
    writeJsonSnapshot({ probe: 'sampling-params', rows })
  }
})
