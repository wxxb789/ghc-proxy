#!/usr/bin/env bun

/**
 * Probe explicit prompt-caching support on Copilot's upstream.
 *
 * OpenAI's caching is automatic by default (>= 1024-token prefixes), but
 * GPT-5.6 and later add explicit control:
 *
 *   - `prompt_cache_key`        — routing key; docs say 5.6+ *must* set it for
 *                                 reliable matching
 *   - `prompt_cache_options`    — `{ mode: 'implicit' | 'explicit', ttl }`
 *   - `prompt_cache_breakpoint` — per-content-block marker, `{ mode: 'explicit' }`
 *   - `usage.cache_write_tokens` — reported on 5.6+ only
 *
 * The proxy already models `prompt_cache_key` and the legacy
 * `prompt_cache_retention`, but not the two newer fields. Copilot is a
 * different deployment from api.openai.com, so none of this can be assumed —
 * hence this probe.
 *
 * Requests are padded past the 1024-token cache threshold, then sent twice so
 * the second call can report a cache hit.
 *
 * Usage:
 *   bun run scripts/probes/prompt-caching.ts
 *   bun run scripts/probes/prompt-caching.ts --json
 */

import process from 'node:process'
import { modelCache, RESPONSES_ENDPOINT } from '~/state'

import { parseProbeArgs } from '../lib/probe-args'
import { bootstrapProbe, probeResponsesEndpoint, runMain, sendRaw } from '../lib/probe-harness'
import { statusIcon, writeJsonSnapshot } from '../lib/probe-report'

const { jsonMode } = parseProbeArgs()

/**
 * Caching only engages past ~1024 tokens, so the prefix has to clear that bar.
 *
 * The prefix is unique **per variant per run**: a fixed one is served from a
 * previous run's cache, so the first call already reports a hit and no cache
 * write* is ever observed. Each variant needs a cold prefix for its own first
 * call, then the identical body is replayed to measure the hit.
 */
const FILLER = 'The quick brown fox jumps over the lazy dog. '.repeat(220)
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

function prefixFor(variantLabel: string): string {
  return `You are a helpful assistant. Session ${RUN_ID} variant ${variantLabel}.\n${FILLER}`
}

function baseBodyWith(modelId: string, prefix: string): Record<string, unknown> {
  return {
    model: modelId,
    max_output_tokens: 16,
    stream: false,
    store: false,
    input: [
      { type: 'message', role: 'system', content: prefix },
      { type: 'message', role: 'user', content: 'Reply OK.' },
    ],
  }
}

/** Same as baseBodyWith but with an explicit breakpoint on the system block. */
function breakpointBodyWith(modelId: string, prefix: string): Record<string, unknown> {
  return {
    model: modelId,
    max_output_tokens: 16,
    stream: false,
    store: false,
    input: [
      {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: prefix,
            prompt_cache_breakpoint: { mode: 'explicit' },
          },
        ],
      },
      { type: 'message', role: 'user', content: 'Reply OK.' },
    ],
  }
}

const VARIANTS = [
  {
    label: 'baseline (implicit)',
    build: baseBodyWith,
  },
  {
    label: 'prompt_cache_key',
    build: (id: string, p: string) => ({
      ...baseBodyWith(id, p),
      prompt_cache_key: `ghc-proxy-probe-${RUN_ID}`,
    }),
  },
  {
    label: 'cache_options.implicit',
    build: (id: string, p: string) => ({
      ...baseBodyWith(id, p),
      prompt_cache_options: { mode: 'implicit' },
    }),
  },
  {
    label: 'cache_options.explicit',
    build: (id: string, p: string) => ({
      ...baseBodyWith(id, p),
      prompt_cache_options: { mode: 'explicit' },
    }),
  },
  {
    label: 'cache_options.ttl=30m',
    build: (id: string, p: string) => ({
      ...baseBodyWith(id, p),
      prompt_cache_options: { mode: 'implicit', ttl: '30m' },
    }),
  },
  {
    label: 'cache_options.ttl=1h',
    build: (id: string, p: string) => ({
      ...baseBodyWith(id, p),
      prompt_cache_options: { mode: 'implicit', ttl: '1h' },
    }),
  },
  {
    label: 'breakpoint on block',
    build: breakpointBodyWith,
  },
  {
    label: 'breakpoint+explicit+key',
    build: (id: string, p: string) => ({
      ...breakpointBodyWith(id, p),
      prompt_cache_options: { mode: 'explicit' },
      prompt_cache_key: `ghc-proxy-probe-${RUN_ID}`,
    }),
  },
  {
    label: 'legacy retention=24h',
    build: (id: string, p: string) => ({
      ...baseBodyWith(id, p),
      prompt_cache_retention: '24h',
    }),
  },
] as const

interface UsageShape {
  input_tokens?: number
  input_tokens_details?: Record<string, unknown>
  cache_write_tokens?: number
  [key: string]: unknown
}

/** Pull the cache-relevant slice of usage, whatever shape it arrives in. */
function summarizeUsage(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null) {
    return ''
  }
  const usage = (parsed as { usage?: UsageShape }).usage
  if (!usage) {
    return 'no usage'
  }

  const details = usage.input_tokens_details ?? {}
  const cached = (details as { cached_tokens?: number }).cached_tokens
  const write = usage.cache_write_tokens
    ?? (details as { cache_write_tokens?: number }).cache_write_tokens

  return [
    `in=${usage.input_tokens ?? '-'}`,
    `cached=${cached ?? '-'}`,
    write !== undefined ? `write=${write}` : undefined,
    // Surface any unexpected keys so a new field is not silently missed.
    `details_keys=[${Object.keys(details).join(',')}]`,
  ].filter(Boolean).join(' ')
}

runMain(async () => {
  await bootstrapProbe({ silent: jsonMode })

  const models = modelCache.getModels()?.data ?? []
  const only = process.argv.slice(2).filter(a => !a.startsWith('--'))
  const eligible = models
    .filter(m => m.supported_endpoints?.includes(RESPONSES_ENDPOINT))
    .filter(m => only.length === 0 || only.includes(m.id))
  const rows: Array<Record<string, unknown>> = []

  if (!jsonMode) {
    process.stdout.write(
      `\n════ PROMPT CACHING · ${RESPONSES_ENDPOINT} — ${eligible.length} model(s) ════\n`
      + `Run ${RUN_ID}. Each variant gets a cold ~${Math.round(prefixFor('x').length / 4)}-token\n`
      + `prefix, sent twice: call 1 should write, call 2 should read.\n\n`,
    )
  }

  for (const model of eligible) {
    if (!jsonMode) {
      process.stdout.write(`--- ${model.id} ---\n`)
    }

    const results: Record<string, unknown> = {}

    for (const variant of VARIANTS) {
      // Unique per model too: the same prefix on two models would let the
      // second model's "cold" call land on a warm cache.
      const prefix = prefixFor(`${model.id}-${variant.label}`)
      const body = variant.build(model.id, prefix) as Record<string, unknown>

      // Call 1 is cold — this is the one that can report a cache WRITE.
      const first = await probeResponsesEndpoint(body, baseBodyWith(model.id, prefix))
      let coldUsage = ''
      let warmUsage = ''

      if (first.status === 'accepted') {
        // Re-read call 1's usage: probeResponsesEndpoint summarizes the body,
        // not usage, so the write has to be observed with a raw send.
        const cold = await sendRaw(
          variant.build(model.id, prefixFor(`${model.id}-${variant.label}-cold`)) as Record<string, unknown>,
          { endpoint: RESPONSES_ENDPOINT },
        )
        coldUsage = summarizeUsage(cold.parsed)

        const warm = await sendRaw(body, { endpoint: RESPONSES_ENDPOINT })
        warmUsage = summarizeUsage(warm.parsed)
      }

      results[variant.label] = {
        status: first.status,
        httpStatus: first.httpStatus,
        note: first.note,
        coldCallUsage: coldUsage,
        warmCallUsage: warmUsage,
      }

      if (!jsonMode) {
        const detail = first.status === 'accepted'
          ? `cold[${coldUsage}] warm[${warmUsage}]`
          : (first.note ?? '').slice(0, 100)
        process.stdout.write(
          `  ${statusIcon(first.status)} ${variant.label.padEnd(24)} `
          + `${String(first.httpStatus ?? '-').padEnd(5)} ${detail}\n`,
        )
      }
    }

    rows.push({ model: model.id, results })

    if (!jsonMode) {
      process.stdout.write('\n')
    }
  }

  if (jsonMode) {
    writeJsonSnapshot({ probe: 'prompt-caching', rows })
  }
})
