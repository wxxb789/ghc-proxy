#!/usr/bin/env node

import process from 'node:process'
import { defineCommand } from 'citty'

import { UpstreamRequestQueue } from './clients/upstream-queue'
import { HTTPError, isRetryableConnectionEstablishmentError } from './lib/error'
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

interface RuntimeProbe {
  name: string
  ok: boolean
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

const RUNTIME_PROBES = [
  ['http-error-response-contract', probeHttpErrorResponseContract],
  ['connection-error-classification', probeConnectionErrorClassification],
  ['response-body-cancellation', probeResponseBodyCancellation],
  ['response-commit-boundary', probeResponseCommitBoundary],
  ['caller-cancellation', probeCallerCancellation],
  ['protocol-payload-contract', probeProtocolPayloadContract],
] as const

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

async function runRuntimeProbe(
  name: string,
  probe: () => void | Promise<void>,
): Promise<RuntimeProbe> {
  try {
    await probe()
    return { name, ok: true }
  }
  catch (error) {
    return {
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function probeHttpErrorResponseContract(): Promise<void> {
  const response = new HTTPError(529, {
    error: { message: 'upstream overloaded', type: 'overloaded_error' },
  }, { headers: { 'retry-after': '17' } }).toResponse()

  assertProbe(response.status === 529, `expected status 529, received ${response.status}`)
  assertProbe(response.headers.get('retry-after') === '17', 'Retry-After was not preserved')
  const payload = await response.json() as { error?: { type?: string } }
  assertProbe(payload.error?.type === 'overloaded_error', 'error payload changed during toResponse()')
}

function probeConnectionErrorClassification(): void {
  assertProbe(
    isRetryableConnectionEstablishmentError({ code: 'ConnectionRefused' }) === 'connection-refused',
    'Bun ConnectionRefused was not classified',
  )
  assertProbe(
    isRetryableConnectionEstablishmentError(new TypeError('fetch failed', {
      cause: { code: 'ECONNREFUSED' },
    })) === 'connection-refused',
    'Node ECONNREFUSED was not classified',
  )
  assertProbe(
    isRetryableConnectionEstablishmentError(new TypeError('fetch failed', {
      cause: { code: 'ENOTFOUND' },
    })) === 'dns',
    'Node ENOTFOUND was not classified',
  )
  assertProbe(
    isRetryableConnectionEstablishmentError({ name: 'TimeoutError', code: 'ECONNREFUSED' }) === undefined,
    'timeout-shaped error was classified as a connection-establishment failure',
  )
}

async function probeResponseBodyCancellation(): Promise<void> {
  const queue = createRuntimeProbeQueue({ maxRetries: 1 })
  let attempts = 0
  let cancelled = false

  const result = await queue.dispatch(async () => {
    attempts++
    if (attempts === 1) {
      return new Response(new ReadableStream({
        cancel() {
          cancelled = true
        },
      }), {
        status: 529,
        headers: { 'retry-after': '0' },
      })
    }
    return new Response('ok')
  }, {
    url: 'https://example.invalid/v1/messages',
    retryable: 'capacity',
  })

  result.release()
  assertProbe(attempts === 2, `expected one retry, observed ${attempts - 1}`)
  assertProbe(cancelled, 'retryable response body was not cancelled')
}

async function probeResponseCommitBoundary(): Promise<void> {
  const queue = createRuntimeProbeQueue({ maxRetries: 1 })
  let attempts = 0
  const result = await queue.dispatch(async () => {
    attempts++
    return new Response(new ReadableStream({
      start(controller) {
        controller.error(new Error('probe stream failure'))
      },
    }))
  }, {
    url: 'https://example.invalid/v1/messages',
    retryable: 'capacity',
  })

  let bodyFailed = false
  try {
    await result.response.text()
  }
  catch {
    bodyFailed = true
  }
  finally {
    result.release()
  }

  assertProbe(bodyFailed, 'probe stream did not fail during body consumption')
  assertProbe(attempts === 1, `committed response was replayed ${attempts - 1} time(s)`)
}

async function probeCallerCancellation(): Promise<void> {
  const queue = createRuntimeProbeQueue()
  const controller = new AbortController()
  const reason = new Error('selfcheck caller cancellation')
  let observedSignal: AbortSignal | undefined

  const pending = queue.dispatch(async (signal) => {
    observedSignal = signal
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) {
        reject(new Error('queue did not pass the caller signal to fetch'))
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }, {
    url: 'https://example.invalid/v1/messages',
    retryable: 'capacity',
  }, controller.signal)

  await Promise.resolve()
  await Promise.resolve()
  controller.abort(reason)

  let rejection: unknown
  try {
    await pending
  }
  catch (error) {
    rejection = error
  }

  assertProbe(observedSignal === controller.signal, 'fetch did not receive the caller signal')
  assertProbe(rejection === reason, 'caller abort reason was not preserved')
}

async function probeProtocolPayloadContract(): Promise<void> {
  const response = new HTTPError(429, {
    error: { message: 'rate limited', type: 'rate_limit_error' },
  }, { headers: { 'retry-after': '5' } }).toResponse()
  const payload = await response.json() as Record<string, unknown>
  const error = payload.error as Record<string, unknown> | undefined

  assertProbe(Object.keys(payload).join(',') === 'error', 'public error payload gained a top-level extension')
  assertProbe(
    error !== undefined && Object.keys(error).sort().join(',') === 'message,type',
    'public error object gained a recovery extension',
  )
  assertProbe(
    [...response.headers.keys()].every(name => !name.startsWith('x-ghc-')),
    'public response gained a non-standard recovery header',
  )
}

function createRuntimeProbeQueue(
  options: { maxRetries?: number } = {},
): UpstreamRequestQueue {
  return new UpstreamRequestQueue({
    concurrency: 1,
    maxRetries: options.maxRetries ?? 0,
    baseDelayMs: 0,
    maxDelayMs: 1,
    maxQueueDepth: 1,
    recoveryBudgetMs: 1_000,
  }, {
    sleep: async () => {},
    random: () => 0,
    logger: { warn() {}, info() {} },
  })
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new Error(message)
}

async function runSelfCheck(options: RunSelfCheckOptions): Promise<void> {
  const probes = await Promise.all(PROBE_ENCODINGS.map(probeEncoding))
  const runtimeProbes = await Promise.all(
    RUNTIME_PROBES.map(([name, probe]) => runRuntimeProbe(name, probe)),
  )
  const failed = [...probes, ...runtimeProbes].filter(p => !p.ok)

  const result = {
    ok: failed.length === 0,
    probes,
    runtimeProbes,
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
    process.stdout.write(`\nghc-proxy runtime probes\n\n`)
    for (const probe of runtimeProbes) {
      const mark = probe.ok ? 'ok ' : 'FAIL'
      const detail = probe.ok ? '' : ` error=${probe.error}`
      process.stdout.write(`  [${mark}] ${probe.name}${detail}\n`)
    }
    const passed = probes.length + runtimeProbes.length - failed.length
    process.stdout.write(`\n${result.ok ? 'PASS' : 'FAIL'} — ${passed}/${probes.length + runtimeProbes.length} probes passed\n`)
  }

  if (!result.ok) {
    process.exitCode = 1
  }
}

export const selfcheck = defineCommand({
  meta: {
    name: 'selfcheck',
    description: 'Probe the packaged bundle for tokenizer and cross-runtime regressions.',
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
