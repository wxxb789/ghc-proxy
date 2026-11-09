import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createTargetRuntime } from '~/accounts/target-runtime'
import { resetMscTokenCache, setMscHelperRunner } from '~/clients/msc-auth'
import { compileAccountRouting } from '~/lib/account-routing'
import { enforceTargetGates } from '~/lib/target-gates'
import { createServer } from '~/server'
import { runtimeStore } from '~/state'
import {
  configureAccountRuntimes,
  createAccountRuntime,
  resetAccountRuntimes,
  runWithAccountRuntime,
  setTargetAvailability,
} from '~/state/account-runtime'

const loopbackServer = {
  requestIP: () => ({ address: '127.0.0.1' }),
}
const remoteServer = {
  requestIP: () => ({ address: '192.168.1.20' }),
}

const temporaryDirs: Array<string> = []
let previousExe: string | undefined
let previousFetch: typeof fetch

function installFakeHelper(): void {
  const dir = mkdtempSync(join(tmpdir(), 'target-gates-helper-'))
  temporaryDirs.push(dir)
  const file = join(dir, 'msc-auth.exe')
  writeFileSync(file, 'fake')
  chmodSync(file, 0o755)
  previousExe = process.env.GHC_MSC_AUTH_EXE
  process.env.GHC_MSC_AUTH_EXE = file
}

function requestTo(hostname: string, pathname: string): Request {
  return new Request(`http://${hostname}${pathname}`, { method: 'POST' })
}

function activate(targets: 'm365-only' | 'mixed') {
  const m365 = createTargetRuntime('m365', 'm365')
  if (targets === 'm365-only') {
    configureAccountRuntimes(
      compileAccountRouting({
        baseHostname: 'localhost',
        defaultAccount: 'm365',
        hostnames: { 'm365.localhost': 'm365' },
      }, []),
      [m365],
    )
    return m365
  }

  const github = createAccountRuntime('default')
  configureAccountRuntimes(
    compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'default',
      hostnames: {
        'default.localhost': 'default',
        'm365.localhost': 'm365',
      },
    }, ['default']),
    [github, m365],
  )
  return m365
}

describe('per-target gates', () => {
  beforeEach(() => {
    resetMscTokenCache()
    installFakeHelper()
    previousFetch = globalThis.fetch
    const stub = async () =>
      Response.json({
        data: [{
          id: 'claude-opus-5.5',
          name: 'Claude Opus 5.5',
          supported_endpoints: ['/v1/messages'],
          capabilities: { type: 'chat' },
        }],
      })
    globalThis.fetch = stub as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = previousFetch
    setMscHelperRunner(undefined)
    resetMscTokenCache()
    if (previousExe === undefined)
      delete process.env.GHC_MSC_AUTH_EXE
    else
      process.env.GHC_MSC_AUTH_EXE = previousExe
    for (const dir of temporaryDirs.splice(0))
      rmSync(dir, { recursive: true, force: true })
  })

  test('leaves a GitHub target untouched', async () => {
    const m365 = activate('mixed')
    void m365
    const github = createAccountRuntime('default')
    const refusal = await runWithAccountRuntime(github, () =>
      enforceTargetGates(requestTo('default.localhost', '/chat/completions'), remoteServer))
    expect(refusal).toBeUndefined()
  })

  test('rejects a non-loopback peer on the M365 target', async () => {
    const m365 = activate('m365-only')
    const refusal = await runWithAccountRuntime(m365, () =>
      enforceTargetGates(requestTo('m365.localhost', '/v1/messages'), remoteServer))

    expect(refusal?.status).toBe(403)
    await expect(refusal!.json()).resolves.toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error' },
    })
  })

  test('rejects a live Node peer even without a resolved address', async () => {
    const m365 = activate('m365-only')
    const nodeRequest = Object.assign(requestTo('m365.localhost', '/v1/messages'), {
      runtime: { name: 'node' },
      ip: undefined,
    })
    const refusal = await runWithAccountRuntime(m365, () =>
      enforceTargetGates(nodeRequest, null))

    expect(refusal?.status).toBe(403)
  })

  test('serves an in-process request without a live peer', async () => {
    const m365 = activate('m365-only')
    const refusal = await runWithAccountRuntime(m365, () =>
      enforceTargetGates(requestTo('m365.localhost', '/v1/models'), undefined))

    expect(refusal).toBeUndefined()
  })

  test('refuses foreign inference endpoints, naming the Messages endpoint', async () => {
    const m365 = activate('m365-only')
    const refusal = await runWithAccountRuntime(m365, () =>
      enforceTargetGates(requestTo('m365.localhost', '/v1/chat/completions'), loopbackServer))

    expect(refusal?.status).toBe(400)
    await expect(refusal!.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('/v1/messages') },
    })
  })

  test('passes dashboard paths to their own guard', async () => {
    const m365 = activate('m365-only')
    setTargetAvailability(m365, { status: 'unavailable', cause: 'no matching broker account' })

    const refusal = await runWithAccountRuntime(m365, () =>
      enforceTargetGates(requestTo('m365.localhost', '/dashboard'), loopbackServer))

    expect(refusal).toBeUndefined()
  })

  test('answers an unavailable target with its cause', async () => {
    const m365 = activate('m365-only')
    setTargetAvailability(m365, { status: 'unavailable', cause: 'no matching broker account' })
    setMscHelperRunner(async () => ({ stdout: '', stderr: '', code: 2 }))

    const refusal = await runWithAccountRuntime(m365, () =>
      enforceTargetGates(requestTo('m365.localhost', '/v1/messages'), loopbackServer))

    expect(refusal?.status).toBe(503)
    await expect(refusal!.json()).resolves.toMatchObject({
      type: 'error',
      error: { message: expect.stringMatching(/unavailable: .+/) },
    })
  })

  test('recovers once the broker answers again', async () => {
    const m365 = activate('m365-only')
    setTargetAvailability(m365, { status: 'unavailable', cause: 'expired' })
    setMscHelperRunner(async () => ({
      stdout: JSON.stringify({
        access_token: 'gateway-token',
        expires_on: new Date(Date.now() + 3_600_000).toISOString(),
        tenant: 'tenant',
      }),
      stderr: '',
      code: 0,
    }))

    const refusal = await runWithAccountRuntime(m365, () =>
      enforceTargetGates(requestTo('m365.localhost', '/v1/messages'), loopbackServer))

    expect(refusal).toBeUndefined()
    expect(m365.models.getModelIds()).toEqual(['claude-opus-5.5'])
  })
  test('refuses the proxy token route end to end without reaching its handler', async () => {
    const m365 = activate('m365-only')
    m365.auth.copilotToken = 'personal-microsoft-token'

    const response = await runWithAccountRuntime(m365, () =>
      createServer().handle(new Request('http://m365.localhost/token')))
    const body = await response.text()

    expect(response.status).toBe(400)
    expect(body).not.toContain('personal-microsoft-token')
    expect(JSON.parse(body)).toEqual({
      error: { message: expect.stringContaining('/v1/messages'), type: 'invalid_request_error' },
    })
  })

  test('records a refused request in the request history', async () => {
    const m365 = activate('m365-only')
    setTargetAvailability(m365, { status: 'unavailable', cause: 'no matching broker account' })
    setMscHelperRunner(async () => ({ stdout: '', stderr: '', code: 2 }))

    const server = createServer()
    const response = await runWithAccountRuntime(m365, () => server.handle(
      new Request('http://m365.localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-5.5', messages: [] }),
      }),
    ))
    await response.text()

    expect(response.status).toBe(503)
    const snapshot = runtimeStore.requests.snapshot()
    expect(snapshot.totals.started).toBeGreaterThan(0)
    expect(snapshot.active.some(entry => entry.endpoint === '/v1/messages')).toBe(true)
  })
})

// The M365 allow-list, stated independently of the gate. Every route the real
// server registers is checked against it, so a route added later is refused
// on the M365 target unless it is added here deliberately.
const M365_SERVED_PATHS = new Set(['/', '/health', '/models', '/v1/models', '/v1/messages', '/v1/messages/count_tokens'])
const ANTHROPIC_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens'])

function servedOnM365(pathname: string): boolean {
  return M365_SERVED_PATHS.has(pathname) || pathname === '/dashboard' || pathname.startsWith('/dashboard/')
}

function errorEnvelope(pathname: string, message: unknown) {
  const body = { error: { message, type: 'invalid_request_error' } }
  return ANTHROPIC_PATHS.has(pathname) ? { type: 'error', ...body } : body
}

interface RouteCase { method: string, path: string }

// `OPTIONS /*` is the CORS catch-all, not a path a client names.
const registeredRoutes: Array<RouteCase> = createServer().routes.filter(route => !route.path.includes('*')).map(route => ({ method: route.method, path: route.path.replaceAll(/:\w+/g, 'x') }))

describe('M365 allow-list over every registered route', () => {
  afterEach(() => {
    setMscHelperRunner(undefined)
    resetMscTokenCache()
  })

  test('enumerates the proxy-specific routes it must refuse', () => {
    const paths = registeredRoutes.map(route => route.path)
    expect(paths).toEqual(expect.arrayContaining(['/token', '/usage', '/decisions', '/v1/decisions']))
  })

  for (const { method, path } of registeredRoutes) {
    test(`${method} ${path} from loopback is ${servedOnM365(path) ? 'admitted' : 'refused'}`, async () => {
      const m365 = activate('m365-only')
      const refusal = await runWithAccountRuntime(m365, () => enforceTargetGates(
        new Request(`http://m365.localhost${path}`, { method }),
        loopbackServer,
      ))

      if (servedOnM365(path)) {
        expect(refusal).toBeUndefined()
        return
      }
      expect(refusal?.status).toBe(400)
      await expect(refusal!.json()).resolves.toEqual(
        errorEnvelope(path, expect.stringContaining('/v1/messages')),
      )
    })

    test(`${method} ${path} from a remote peer is refused in its dialect`, async () => {
      const m365 = activate('m365-only')
      const refusal = await runWithAccountRuntime(m365, () => enforceTargetGates(
        new Request(`http://m365.localhost${path}`, { method }),
        remoteServer,
      ))

      expect(refusal?.status).toBe(403)
      await expect(refusal!.json()).resolves.toEqual(
        errorEnvelope(path, expect.stringContaining('local machine')),
      )
    })
  }

  for (const { path, served } of [
    { path: '/v1/models/', served: true },
    { path: '/dashboard/', served: true },
    { path: '/token/', served: false },
    { path: '/v1/decisions/', served: false },
    { path: '/dashboardx', served: false },
    { path: '/v1/messages//', served: false },
    { path: '/v2/messages', served: false },
    { path: '/unknown', served: false },
  ]) {
    test(`${path} is ${served ? 'admitted' : 'refused'} after trailing-slash normalization`, async () => {
      const m365 = activate('m365-only')
      const refusal = await runWithAccountRuntime(m365, () =>
        enforceTargetGates(requestTo('m365.localhost', path), loopbackServer))

      expect(refusal?.status).toBe(served ? undefined : 400)
    })
  }
})

afterAll(() => {
  resetAccountRuntimes()
})
