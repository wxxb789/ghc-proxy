#!/usr/bin/env node

import type { Socket } from 'node:net'
import type { Dispatcher } from 'undici'

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { node } from '@elysiajs/node'
import { defineCommand } from 'citty'
import { Elysia } from 'elysia'
import { Agent } from 'undici'

import { UpstreamRequestQueue } from '~/clients/upstream-queue'
import { compileAccountRouting } from '~/lib/account-routing'
import {
  finalizeGitHubCredentialMigration,
  prepareGitHubCredential,
  readGitHubCredential,
  replaceGitHubCredentialDuringMigration,
  writeGitHubCredential,
} from '~/lib/credentials'
import { HTTPError, isRetryableConnectionEstablishmentError } from '~/lib/error'
import { getTokenCount } from '~/lib/tokenizer'
import { createDashboardRoutes } from '~/routes/dashboard/route'
import { createServer as createProxyServer } from '~/server'
import {
  configureAccountRuntimes,
  createAccountRuntime,
  resetAccountRuntimes,
} from '~/state'

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
  ['credential-store-migration-contract', probeCredentialStoreMigrationContract],
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
  const server = createHttpServer((_request, response) => {
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

async function probeCredentialStoreMigrationContract(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'ghc-proxy-selfcheck-credentials-'))
  const paths = {
    CONFIG_PATH: path.join(directory, 'config.json'),
    CREDENTIALS_PATH: path.join(directory, 'credentials.json'),
    CONFIG_MIGRATION_BACKUP_PATH: path.join(
      directory,
      'config.json.github-token-migration.bak',
    ),
  }
  const legacyConfig = JSON.stringify({
    githubToken: 'selfcheck-github-token',
    smallModel: 'selfcheck-small-model',
  })

  try {
    await fs.writeFile(paths.CONFIG_PATH, legacyConfig)
    const prepared = await prepareGitHubCredential(paths)
    assertProbe(prepared?.githubToken === 'selfcheck-github-token', 'legacy credential was not staged')
    assertProbe(prepared.migrationPending, 'legacy credential migration was not marked pending')
    assertProbe(
      await fs.readFile(paths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8') === legacyConfig,
      'migration backup did not preserve the complete config',
    )

    const credentialsContent = await fs.readFile(paths.CREDENTIALS_PATH, 'utf8')
    assertProbe(
      !credentialsContent.includes('selfcheck-github-token'),
      'credentials.json persisted the raw GitHub token',
    )
    assertProbe(
      await finalizeGitHubCredentialMigration('selfcheck-github-token', paths),
      'pending credential migration was not finalized',
    )

    const config = JSON.parse(await fs.readFile(paths.CONFIG_PATH, 'utf8')) as Record<string, unknown>
    assertProbe(!('githubToken' in config), 'config.json retained the raw GitHub token')
    assertProbe(config.smallModel === 'selfcheck-small-model', 'config cleanup lost a non-credential field')

    let backupExists = true
    try {
      await fs.access(paths.CONFIG_MIGRATION_BACKUP_PATH)
    }
    catch {
      backupExists = false
    }
    assertProbe(!backupExists, 'migration backup was not removed after finalization')

    const divergentConfig = JSON.stringify({
      githubToken: 'selfcheck-original-github-token',
      smallModel: 'selfcheck-small-model',
    })
    await fs.writeFile(paths.CONFIG_PATH, divergentConfig)

    const existingCredential = await fs.readFile(paths.CREDENTIALS_PATH, 'utf8')
    let initialMismatchRejected = false
    try {
      await prepareGitHubCredential(paths)
    }
    catch {
      initialMismatchRejected = true
    }
    assertProbe(initialMismatchRejected, 'first migration overwrote an existing active credential')
    assertProbe(
      await fs.readFile(paths.CREDENTIALS_PATH, 'utf8') === existingCredential,
      'rejected first migration changed the existing credential store',
    )
    assertProbe(
      await fs.readFile(paths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8') === divergentConfig,
      'rejected first migration did not preserve the complete config backup',
    )

    await fs.rm(paths.CREDENTIALS_PATH)
    await fs.rm(paths.CONFIG_MIGRATION_BACKUP_PATH)
    const replacementConfig = JSON.stringify({
      githubToken: 'selfcheck-replacement-legacy-token',
      smallModel: 'selfcheck-small-model',
    })
    await fs.writeFile(paths.CONFIG_PATH, replacementConfig)
    await prepareGitHubCredential(paths)
    await replaceGitHubCredentialDuringMigration(
      'selfcheck-replacement-legacy-token',
      'selfcheck-replacement-token',
      'corp.ghe.com',
      paths,
    )
    const replacement = await readGitHubCredential(paths)
    assertProbe(
      replacement?.githubToken === 'selfcheck-replacement-token'
      && replacement.gheDomain === 'corp.ghe.com',
      'validated replacement credential was not committed',
    )
    const replacementCleanConfig = JSON.parse(
      await fs.readFile(paths.CONFIG_PATH, 'utf8'),
    ) as Record<string, unknown>
    assertProbe(
      !('githubToken' in replacementCleanConfig),
      'replacement migration retained the legacy config token',
    )

    await fs.rm(paths.CREDENTIALS_PATH)
    const interruptedReplacementConfig = JSON.stringify({
      githubToken: 'selfcheck-interrupted-legacy-token',
      smallModel: 'selfcheck-small-model',
    })
    await fs.writeFile(paths.CONFIG_PATH, interruptedReplacementConfig)
    await prepareGitHubCredential(paths)
    const interruptedReplacementToken = 'selfcheck-interrupted-replacement-token'
    await fs.writeFile(
      `${paths.CONFIG_MIGRATION_BACKUP_PATH}.replacement.json`,
      JSON.stringify({
        version: 1,
        legacyTokenDigest: createHash('sha256')
          .update('selfcheck-interrupted-legacy-token', 'utf8')
          .digest('hex'),
        replacementTokenDigest: createHash('sha256')
          .update(interruptedReplacementToken, 'utf8')
          .digest('hex'),
      }),
    )
    await writeGitHubCredential(interruptedReplacementToken, 'corp.ghe.com', paths)

    const resumedReplacement = await prepareGitHubCredential(paths)
    assertProbe(
      resumedReplacement?.githubToken === interruptedReplacementToken
      && resumedReplacement.migrationPending
      && resumedReplacement.replacementPending,
      'interrupted replacement migration did not resume with the validated replacement candidate',
    )
    assertProbe(
      await finalizeGitHubCredentialMigration(interruptedReplacementToken, paths),
      'interrupted replacement migration was not finalized after restart validation',
    )
    let replacementJournalExists = true
    try {
      await fs.access(`${paths.CONFIG_MIGRATION_BACKUP_PATH}.replacement.json`)
    }
    catch {
      replacementJournalExists = false
    }
    assertProbe(!replacementJournalExists, 'replacement migration journal survived successful finalization')

    await fs.rm(paths.CREDENTIALS_PATH)
    const cleanedSplitConfig = JSON.stringify({
      githubToken: 'selfcheck-cleaned-split-legacy-token',
      smallModel: 'selfcheck-small-model',
    })
    await fs.writeFile(paths.CONFIG_PATH, cleanedSplitConfig)
    await prepareGitHubCredential(paths)
    await fs.writeFile(paths.CONFIG_PATH, JSON.stringify({
      smallModel: 'selfcheck-small-model',
    }))
    await replaceGitHubCredentialDuringMigration(
      'selfcheck-cleaned-split-legacy-token',
      'selfcheck-cleaned-split-replacement-token',
      undefined,
      paths,
    )
    assertProbe(
      (await readGitHubCredential(paths))?.githubToken
      === 'selfcheck-cleaned-split-replacement-token',
      'cleaned config split state rejected a validated replacement credential',
    )

    await fs.rm(paths.CREDENTIALS_PATH)
    await fs.writeFile(paths.CONFIG_PATH, divergentConfig)
    await prepareGitHubCredential(paths)
    await writeGitHubCredential('selfcheck-drifted-github-token', undefined, paths)

    const configBeforeRejection = await fs.readFile(paths.CONFIG_PATH, 'utf8')
    const credentialsBeforeRejection = await fs.readFile(paths.CREDENTIALS_PATH, 'utf8')
    const backupBeforeRejection = await fs.readFile(paths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')

    let prepareRejected = false
    try {
      await prepareGitHubCredential(paths)
    }
    catch {
      prepareRejected = true
    }
    assertProbe(prepareRejected, 'pending migration accepted a credential that drifted from its backup')

    let finalizeRejected = false
    try {
      await finalizeGitHubCredentialMigration('selfcheck-drifted-github-token', paths)
    }
    catch {
      finalizeRejected = true
    }
    assertProbe(finalizeRejected, 'migration finalization accepted a credential that drifted from its backup')

    assertProbe(
      await fs.readFile(paths.CONFIG_PATH, 'utf8') === configBeforeRejection,
      'rejected migration changed config.json',
    )
    assertProbe(
      await fs.readFile(paths.CREDENTIALS_PATH, 'utf8') === credentialsBeforeRejection,
      'rejected migration changed credentials.json',
    )
    assertProbe(
      await fs.readFile(paths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8') === backupBeforeRejection,
      'rejected migration removed or changed the migration backup',
    )
  }
  finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

async function probeDashboardBundleContract(): Promise<void> {
  const app = createDashboardRoutes()
  const [htmlResponse, cssResponse, jsResponse, accountsResponse] = await Promise.all([
    app.handle(new Request('http://localhost/dashboard')),
    app.handle(new Request('http://localhost/dashboard/styles.css')),
    app.handle(new Request('http://localhost/dashboard/app.js')),
    app.handle(new Request('http://localhost/dashboard/api/accounts')),
  ])

  assertProbe(htmlResponse.status === 200, `dashboard HTML returned ${htmlResponse.status}`)
  assertProbe(cssResponse.status === 200, `dashboard CSS returned ${cssResponse.status}`)
  assertProbe(jsResponse.status === 200, `dashboard JS returned ${jsResponse.status}`)
  assertProbe(
    accountsResponse.status === 409,
    `dashboard account management availability returned ${accountsResponse.status}`,
  )

  const [html, css, js] = await Promise.all([
    htmlResponse.text(),
    cssResponse.text(),
    jsResponse.text(),
  ])
  assertProbe(html.includes('/dashboard/styles.css'), 'dashboard HTML lost its CSS route')
  assertProbe(html.includes('/dashboard/app.js'), 'dashboard HTML lost its JS route')
  assertProbe(html.includes('data-tab="accounts"'), 'dashboard HTML lost its Accounts view')
  assertProbe(html.includes('id="account-bootstrap-form"'), 'dashboard HTML lost legacy routing bootstrap')
  assertProbe(css.includes('.app-header'), 'dashboard CSS was not bundled')
  assertProbe(css.includes('.account-auth[hidden]'), 'dashboard CSS lost hidden auth state')
  assertProbe(js.includes('fetchJson(\'/dashboard/api/overview\')'), 'dashboard JS was not bundled')
  assertProbe(js.includes('/dashboard/api/accounts/bootstrap'), 'dashboard JS lost legacy routing bootstrap')
  assertProbe(js.includes('/dashboard/api/accounts/default'), 'dashboard JS lost default-account management')
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

async function probeAccountHostnameRouting(): Promise<void> {
  const defaultRuntime = createAccountRuntime('default')
  defaultRuntime.auth.copilotToken = 'selfcheck-default-token'
  const account1Runtime = createAccountRuntime('account1')
  account1Runtime.auth.copilotToken = 'selfcheck-account1-token'
  configureAccountRuntimes(
    compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'default',
      hostnames: {
        'default.localhost': 'default',
        'account1.localhost': 'account1',
      },
    }, ['default', 'account1']),
    [defaultRuntime, account1Runtime],
  )

  const app = createProxyServer({ logRequests: false })
  let nodeListener: NodeDashboardListener | undefined
  try {
    app.listen({ hostname: '127.0.0.1', port: 0 }, (server) => {
      if (!process.versions.bun) {
        nodeListener = server as unknown as NodeDashboardListener
      }
    })

    let port: number
    if (process.versions.bun) {
      port = (app.server as unknown as { port: number }).port
    }
    else {
      assertProbe(nodeListener !== undefined, 'Node account-routing listener was not created')
      await nodeListener.raw.ready()
      assertProbe(nodeListener.raw.url !== undefined, 'Node account-routing listener has no URL')
      port = Number(new URL(nodeListener.raw.url).port)
    }
    assertProbe(Number.isInteger(port) && port > 0, 'account-routing listener has no bound port')

    const defaultResponse = await requestAccountRoute(port, 'localhost')
    const loopbackResponse = await requestAccountRoute(port, '127.0.0.1')
    const account1Response = await requestAccountRoute(port, 'account1.localhost')
    const unknownResponse = await requestAccountRoute(port, 'unknown.localhost')
    const unknownRootResponse = await requestAccountRoute(port, 'unknown.localhost', '/')

    assertProbe(defaultResponse.status === 200, `default hostname returned ${defaultResponse.status}`)
    assertProbe(
      JSON.parse(defaultResponse.body).token === 'selfcheck-default-token',
      'default hostname selected the wrong account',
    )
    assertProbe(loopbackResponse.status === 200, `loopback hostname returned ${loopbackResponse.status}`)
    assertProbe(
      JSON.parse(loopbackResponse.body).token === 'selfcheck-default-token',
      'loopback hostname selected the wrong account',
    )
    assertProbe(account1Response.status === 200, `named hostname returned ${account1Response.status}`)
    assertProbe(
      JSON.parse(account1Response.body).token === 'selfcheck-account1-token',
      'named hostname selected the wrong account',
    )
    assertProbe(unknownResponse.status === 421, `unknown hostname returned ${unknownResponse.status}`)
    assertProbe(unknownRootResponse.status === 421, `unknown hostname root returned ${unknownRootResponse.status}`)
  }
  finally {
    if (process.versions.bun) {
      await app.stop()
    }
    else {
      await nodeListener?.raw.close(true)
    }
    resetAccountRuntimes()
  }
}

async function requestAccountRoute(
  port: number,
  hostname: string,
  requestPath = '/token',
): Promise<HttpProbeResult> {
  try {
    if (process.versions.bun) {
      const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
        headers: { host: `${hostname}:${port}` },
      })
      return { body: await response.text(), status: response.status }
    }
    return await requestLocal('127.0.0.1', port, `${hostname}:${port}`, requestPath)
  }
  catch (error) {
    throw new Error(`account-routing request for ${hostname} failed: ${error instanceof Error ? error.message : String(error)}`)
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
  return requestLocal(address, port, `localhost:${port}`, '/dashboard')
}

function requestLocal(
  address: string,
  port: number,
  host: string,
  requestPath: string,
): Promise<HttpProbeResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: {
        connection: 'close',
        host,
      },
      hostname: address,
      method: 'GET',
      path: requestPath,
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
  const parallelRuntimeProbes = await Promise.all(
    RUNTIME_PROBES.map(([name, probe]) => runRuntimeProbe(name, probe)),
  )
  const runtimeProbes = [
    ...parallelRuntimeProbes,
    await runRuntimeProbe('account-hostname-routing', probeAccountHostnameRouting),
  ]
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
