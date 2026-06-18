#!/usr/bin/env node

import process from 'node:process'
import { defineCommand } from 'citty'

import { getTokenCount } from './lib/tokenizer'

interface RunSelfCheckOptions {
  json: boolean
}

interface EncodingProbe {
  encoding: string
  ok: boolean
  tokenCount?: number
  error?: string
}

const PROBE_ENCODINGS = [
  'o200k_base',
  'cl100k_base',
  'p50k_base',
  'p50k_edit',
  'r50k_base',
] as const

const PROBE_MESSAGE = 'ghc-proxy selfcheck: probe text for tokenizer chunk load'

async function probeEncoding(encoding: string): Promise<EncodingProbe> {
  try {
    const count = await getTokenCount(
      { messages: [{ role: 'user', content: PROBE_MESSAGE }] } as never,
      // Synthesize the minimum Model shape `getTokenCount` reads: only
      // `capabilities.tokenizer` and `id` are touched on this codepath.
      { id: `selfcheck-${encoding}`, capabilities: { tokenizer: encoding } } as never,
    )
    if (count.input <= 0) {
      // The non-empty PROBE_MESSAGE must yield at least one token. A zero
      // count means the encoder loaded but its encode() returned an empty
      // array — a silent regression mode (e.g. a tsdown DCE that strips
      // the encoder's table-init side effect) that ok:true would miss.
      throw new Error(`encoder for ${encoding} returned 0 tokens for non-empty input`)
    }
    return { encoding, ok: true, tokenCount: count.input }
  }
  catch (error) {
    return {
      encoding,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runSelfCheck(options: RunSelfCheckOptions): Promise<void> {
  const probes = await Promise.all(PROBE_ENCODINGS.map(probeEncoding))
  const failed = probes.filter(p => !p.ok)

  const result = {
    ok: failed.length === 0,
    probes,
    failedCount: failed.length,
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }
  else {
    process.stdout.write(`ghc-proxy selfcheck — tokenizer dynamic-chunk load\n\n`)
    for (const probe of probes) {
      const mark = probe.ok ? 'ok ' : 'FAIL'
      const detail = probe.ok
        ? `tokens=${probe.tokenCount}`
        : `error=${probe.error}`
      process.stdout.write(`  [${mark}] ${probe.encoding.padEnd(12)} ${detail}\n`)
    }
    process.stdout.write(`\n${result.ok ? 'PASS' : 'FAIL'} — ${probes.length - failed.length}/${probes.length} encodings loaded\n`)
  }

  if (!result.ok) {
    process.exitCode = 1
  }
}

export const selfcheck = defineCommand({
  meta: {
    name: 'selfcheck',
    description: 'Probe the packaged bundle for runtime regressions (loads every gpt-tokenizer dynamic chunk and encodes a probe string).',
  },
  args: {
    json: {
      type: 'boolean',
      default: false,
      description: 'Output probe results as JSON',
    },
  },
  run({ args }) {
    return runSelfCheck({
      json: args.json,
    })
  },
})
