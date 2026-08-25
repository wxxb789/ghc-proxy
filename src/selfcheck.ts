#!/usr/bin/env node

import type { Socket } from 'node:net'
import type { Dispatcher } from 'undici'

import { createServer, request as httpRequest } from 'node:http'
import { networkInterfaces } from 'node:os'
import process from 'node:process'
import { node } from '@elysiajs/node'
import { defineCommand } from 'citty'
import { Elysia } from 'elysia'
import { Agent } from 'undici'

import { UpstreamRequestQueue } from './clients/upstream-queue'
import { HTTPError, isRetryableConnectionEstablishmentError } from './lib/error'
import { getTokenCount } from './lib/tokenizer'
import { createDashboardRoutes } from './routes/dashboard/route'

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

interface NodeDashboardListener {
  raw: {
    close: (closeActiveConnections?: boolean) => Promise<void>
    ready: () => Promise<unknown>
    readonly url?: string
  }
}

interface HttpProbeResult {
  body: string
  status: number
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
  ['dashboard-bundle-contract', probeDashboardBundleContract],
  ['dashboard-node-listener-boundary', probeDashboardNodeListenerBoundary],
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
  const dispatcher = process.versions.bun ? undefined : new Agent({ connections: 1 })
  const sockets = new Set<Socket>()
  let requests = 0
  let firstResponseClosed = false
  const server = createServer((_request, response) => {
    requests++
    if (requests === 1) {
      response.once('close', () => {
        firstResponseClosed = true
      })
      response.writeHead(529, { 'retry-after': '0' })
      response.write('retryable response remains open')
      return
    }
    response.end('ok')
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  try {
    const address = server.address()
    assertProbe(address !== null && typeof address === 'object', 'loopback server has no address')
    const url = `http://127.0.0.1:${address.port}/retry`
    const result = await queue.dispatch(
      signal => fetch(url, {
        signal,
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit & { dispatcher?: Dispatcher }),
      { url, retryable: 'capacity' },
    )

    try {
      assertProbe(result.response.status === 200, `expected retry status 200, received ${result.response.status}`)
      assertProbe(await result.response.text() === 'ok', 'retry response body changed')
    }
    finally {
      result.release()
    }

    assertProbe(requests === 2, `expected one retry, observed ${requests - 1}`)
    if (!process.versions.bun) {
      assertProbe(firstResponseClosed, 'retryable response did not release its transport')
    }
  }
  finally {
    for (const socket of sockets)
      socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await dispatcher?.close()
  }
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

async function probeDashboardBundleContract(): Promise<void> {
  const app = createDashboardRoutes()
  const [htmlResponse, cssResponse, jsResponse] = await Promise.all([
    app.handle(new Request('http://localhost/dashboard')),
    app.handle(new Request('http://localhost/dashboard/styles.css')),
    app.handle(new Request('http://localhost/dashboard/app.js')),
  ])

  assertProbe(htmlResponse.status === 200, `dashboard HTML returned ${htmlResponse.status}`)
  assertProbe(cssResponse.status === 200, `dashboard CSS returned ${cssResponse.status}`)
  assertProbe(jsResponse.status === 200, `dashboard JS returned ${jsResponse.status}`)

  const [html, css, js] = await Promise.all([
    htmlResponse.text(),
    cssResponse.text(),
    jsResponse.text(),
  ])
  assertProbe(html.includes('/dashboard/styles.css'), 'dashboard HTML lost its CSS route')
  assertProbe(html.includes('/dashboard/app.js'), 'dashboard HTML lost its JS route')
  assertProbe(css.includes('.app-header'), 'dashboard CSS was not bundled')
  assertProbe(js.includes('fetchJson(\'/dashboard/api/overview\')'), 'dashboard JS was not bundled')
  assertProbe(!js.includes('innerHTML'), 'dashboard JS uses unsafe HTML insertion')
}

async function probeDashboardNodeListenerBoundary(): Promise<void> {
  if (process.versions.bun)
    return

  const app = new Elysia({ adapter: node() }).use(createDashboardRoutes())
  let listener: NodeDashboardListener | undefined

  try {
    app.listen({ hostname: '0.0.0.0', port: 0 }, (server) => {
      listener = server as unknown as NodeDashboardListener
    })
    assertProbe(listener !== undefined, 'Node dashboard listener was not created')
    await listener.raw.ready()
    assertProbe(listener.raw.url !== undefined, 'Node dashboard listener has no URL')

    const port = Number(new URL(listener.raw.url).port)
    assertProbe(Number.isInteger(port) && port > 0, 'Node dashboard listener has no bound port')

    const loopback = await requestDashboard('127.0.0.1', port)
    assertProbe(loopback.status === 200, `loopback dashboard request returned ${loopback.status}`)
    assertProbe(loopback.body.includes('/dashboard/styles.css'), 'loopback dashboard response lost its HTML')

    const remoteAddress = firstNonLoopbackIpv4Address()
    if (remoteAddress) {
      const remote = await requestDashboard(remoteAddress, port)
      assertProbe(remote.status === 403, `non-loopback dashboard request returned ${remote.status}`)
    }
  }
  finally {
    await listener?.raw.close(true)
  }
}

function firstNonLoopbackIpv4Address(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal)
        return address.address
    }
  }
}

function requestDashboard(address: string, port: number): Promise<HttpProbeResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: {
        connection: 'close',
        host: `localhost:${port}`,
      },
      hostname: address,
      method: 'GET',
      path: '/dashboard',
      port,
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => body += chunk)
      response.on('end', () => resolve({
        body,
        status: response.statusCode ?? 0,
      }))
    })

    request.on('error', reject)
    request.setTimeout(5_000, () => {
      request.destroy(new Error(`dashboard listener probe timed out for ${address}`))
    })
    request.end()
  })
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
