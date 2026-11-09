import type { AccountManagementSnapshot } from '~/accounts/manager'
import type { MscHelperRunner } from '~/clients/msc-auth'
import type { DashboardAccountManagement } from '~/routes/dashboard/route'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { AccountManagementError } from '~/accounts/manager'
import { createTargetRuntime } from '~/accounts/target-runtime'
import { resetMscTokenCache, setMscHelperRunner } from '~/clients/msc-auth'
import { createDashboardRoutes } from '~/routes/dashboard/route'
import { createAccountRuntime, resetAccountRuntimes } from '~/state'

import {
  restoreStateSnapshot,
  saveStateSnapshot,
  setupDefaultTestState,
} from './helpers'

let snapshot: ReturnType<typeof saveStateSnapshot>

beforeEach(() => {
  snapshot = saveStateSnapshot()
  setupDefaultTestState()
})

afterEach(() => {
  setMscHelperRunner()
  resetMscTokenCache()
  resetAccountRuntimes()
  restoreStateSnapshot(snapshot)
})

type M365TargetInput = Parameters<DashboardAccountManagement['registerM365Target']>[0]
type M365ConfigureInput = Parameters<DashboardAccountManagement['configureM365Target']>[0]

/**
 * A route-level fake: the account table starts GitHub-only and registration
 * adds the reserved M365 target, so responses show whether the route reports
 * the post-mutation state.
 */
function fakeManager(options: { mscAuthExe?: string } = {}) {
  const github = createAccountRuntime('default')
  const m365 = createTargetRuntime('m365', 'm365', { mscAuthAccount: 'home-account' })
  let accounts: AccountManagementSnapshot['accounts'] = [
    { name: 'default', hostname: 'default.localhost', isDefault: true, runtime: github },
    { name: 'work', hostname: 'work.localhost', isDefault: false, runtime: createAccountRuntime('work') },
  ]
  return {
    getAccountSnapshot: (): AccountManagementSnapshot => ({
      routing: { baseHostname: 'localhost', defaultAccount: 'default', routingEnabled: true },
      accounts,
    }),
    getMscAuthExe: () => options.mscAuthExe,
    registerM365Target: mock(async (_input: M365TargetInput) => {
      accounts = [...accounts, { name: 'm365', hostname: 'm365.localhost', isDefault: false, runtime: m365 }]
    }),
    configureM365Target: mock(async (_input: M365ConfigureInput) => {}),
    removeAccount: mock(async (_accountName: string) => {}),
    removeM365Target: mock(async () => {}),
    beginAddAccount: mock(async () => {
      throw new Error('not used')
    }),
    bootstrapAccountRouting: mock(async () => {}),
    getAuthenticationSession: () => undefined,
    setDefaultAccount: mock(async () => {}),
  } satisfies DashboardAccountManagement
}

function dashboardRequest(
  path: string,
  init: { method?: string, body?: unknown, origin?: string } = {},
): Request {
  const headers: Record<string, string> = {}
  if (init.body !== undefined)
    headers['content-type'] = 'application/json'
  if (init.origin)
    headers.origin = init.origin
  return new Request(`http://localhost${path}`, {
    method: init.method ?? 'POST',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  try {
    return await run()
  }
  finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

describe('POST /dashboard/api/m365/probe', () => {
  test('reports an unsupported platform without account management and without running the helper', async () => {
    const runner = mock<MscHelperRunner>(async () => ({ code: 0, stdout: '', stderr: '' }))
    setMscHelperRunner(runner)

    const response = await withPlatform('linux', () =>
      createDashboardRoutes().handle(dashboardRequest('/dashboard/api/m365/probe')))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      schemaVersion: 1,
      platformSupported: false,
      helperAvailable: false,
      failedStep: 'platform',
    })
    expect(runner).not.toHaveBeenCalled()
  })

  test('lists broker accounts through the manager-provided helper path', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dashboard-m365-probe-'))
    const exe = join(directory, 'msc-auth.exe')
    writeFileSync(exe, 'unused')
    const runner = mock<MscHelperRunner>(async () => ({
      code: 0,
      stderr: '',
      stdout: 'operator@example.com\toperator.tenant\tlogin.microsoftonline.com\r\n',
    }))
    setMscHelperRunner(runner)
    try {
      const app = createDashboardRoutes({ accountManager: fakeManager({ mscAuthExe: exe }) })
      const response = await withPlatform('win32', () =>
        app.handle(dashboardRequest('/dashboard/api/m365/probe')))

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        platformSupported: true,
        helperAvailable: true,
        accountCount: 1,
        accounts: [{
          upn: 'operator@example.com',
          homeAccountId: 'operator.tenant',
          environment: 'login.microsoftonline.com',
        }],
      })
      expect(runner).toHaveBeenCalledTimes(1)
      expect(runner.mock.calls[0]?.[0]).toBe(exe)
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('reports a missing helper as the failed step', async () => {
    const runner = mock<MscHelperRunner>(async () => ({ code: 0, stdout: '', stderr: '' }))
    setMscHelperRunner(runner)
    const missing = join(tmpdir(), 'dashboard-m365-probe-missing', 'msc-auth.exe')
    const app = createDashboardRoutes({ accountManager: fakeManager({ mscAuthExe: missing }) })

    const response = await withPlatform('win32', () =>
      app.handle(dashboardRequest('/dashboard/api/m365/probe')))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      platformSupported: true,
      helperAvailable: false,
      failedStep: 'helper',
    })
    expect(runner).not.toHaveBeenCalled()
  })
})

describe('POST /dashboard/api/m365/register', () => {
  test('passes the parsed target to the manager and returns the registered projection', async () => {
    const manager = fakeManager()
    const app = createDashboardRoutes({ accountManager: manager, serverPort: 4141 })

    const response = await app.handle(dashboardRequest('/dashboard/api/m365/register', {
      origin: 'http://localhost',
      body: {
        account: 'home-account',
        hostname: 'm365.localhost',
        endpoint: ' https://df.loki.delve.office.com/api/v1/llmapi/ ',
      },
    }))

    expect(response.status).toBe(200)
    expect(manager.registerM365Target).toHaveBeenCalledWith({
      account: 'home-account',
      hostname: 'm365.localhost',
      endpoint: 'https://df.loki.delve.office.com/api/v1/llmapi',
    })
    expect(await response.json()).toMatchObject({
      schemaVersion: 1,
      registered: true,
      hostname: 'm365.localhost',
      account: 'home-account',
      onboarding: { status: 'available' },
    })
  })

  test('accepts an empty body and forwards a null account', async () => {
    const manager = fakeManager()
    const app = createDashboardRoutes({ accountManager: manager })

    const empty = await app.handle(dashboardRequest('/dashboard/api/m365/register', { body: {} }))
    const unpinned = await app.handle(dashboardRequest('/dashboard/api/m365/register', { body: { account: null } }))

    expect(empty.status).toBe(200)
    expect(unpinned.status).toBe(200)
    expect(manager.registerM365Target.mock.calls).toEqual([[{}], [{ account: null }]])
  })

  const invalidBodies: Array<{ name: string, body: unknown }> = [
    { name: 'an unknown field', body: { account: 'home', extra: true } },
    { name: 'an empty hostname', body: { hostname: '' } },
    { name: 'a non-HTTPS endpoint', body: { endpoint: 'http://loki.delve.office.com/api/v1/llmapi' } },
    { name: 'an endpoint with a query', body: { endpoint: 'https://loki.delve.office.com/api/v1/llmapi?x=1' } },
    { name: 'a non-string account', body: { account: 42 } },
  ]
  for (const { name, body } of invalidBodies) {
    test(`rejects ${name} with 400 before reaching the manager`, async () => {
      const manager = fakeManager()
      const response = await createDashboardRoutes({ accountManager: manager })
        .handle(dashboardRequest('/dashboard/api/m365/register', { body }))

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { message: 'Invalid M365 target payload.', type: 'invalid_request_error' },
      })
      expect(manager.registerM365Target).not.toHaveBeenCalled()
    })
  }
})

describe('POST /dashboard/api/m365/account', () => {
  test('forwards only the parsed account selection', async () => {
    const manager = fakeManager()
    const app = createDashboardRoutes({ accountManager: manager })

    const selected = await app.handle(dashboardRequest('/dashboard/api/m365/account', {
      body: { account: 'work-account', hostname: 'ignored.localhost' },
    }))
    const cleared = await app.handle(dashboardRequest('/dashboard/api/m365/account', {
      body: { account: null },
    }))

    expect(selected.status).toBe(200)
    expect(cleared.status).toBe(200)
    expect(manager.configureM365Target.mock.calls).toEqual([
      [{ account: 'work-account' }],
      [{ account: null }],
    ])
    expect(await selected.json()).toMatchObject({ schemaVersion: 1, registered: false })
  })

  test('rejects an invalid selection with 400 before reaching the manager', async () => {
    const manager = fakeManager()
    const response = await createDashboardRoutes({ accountManager: manager })
      .handle(dashboardRequest('/dashboard/api/m365/account', { body: { account: 42 } }))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { message: 'Invalid account selection payload.' },
    })
    expect(manager.configureM365Target).not.toHaveBeenCalled()
  })
})

describe('POST /dashboard/api/m365/hostname', () => {
  test('forwards only the parsed hostname', async () => {
    const manager = fakeManager()
    const response = await createDashboardRoutes({ accountManager: manager })
      .handle(dashboardRequest('/dashboard/api/m365/hostname', {
        body: { hostname: 'copilot.localhost', account: 'ignored' },
      }))

    expect(response.status).toBe(200)
    expect(manager.configureM365Target).toHaveBeenCalledWith({ hostname: 'copilot.localhost' })
    expect(await response.json()).toMatchObject({ schemaVersion: 1, registered: false })
  })

  const invalidBodies: Array<{ name: string, body: unknown }> = [
    { name: 'a missing hostname', body: {} },
    { name: 'an empty hostname', body: { hostname: '' } },
    { name: 'an unknown field', body: { hostname: 'copilot.localhost', extra: true } },
  ]
  for (const { name, body } of invalidBodies) {
    test(`rejects ${name} with 400 before reaching the manager`, async () => {
      const manager = fakeManager()
      const response = await createDashboardRoutes({ accountManager: manager })
        .handle(dashboardRequest('/dashboard/api/m365/hostname', { body }))

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { message: 'Invalid hostname payload.' },
      })
      expect(manager.configureM365Target).not.toHaveBeenCalled()
    })
  }
})

describe('DELETE /dashboard/api/accounts/:accountName', () => {
  test('removes the decoded account name and returns the routing summary', async () => {
    const manager = fakeManager()
    const app = createDashboardRoutes({ accountManager: manager })

    const response = await app.handle(dashboardRequest(
      `/dashboard/api/accounts/${encodeURIComponent('work')}`,
      { method: 'DELETE', origin: 'http://localhost' },
    ))
    const spaced = await app.handle(dashboardRequest(
      `/dashboard/api/accounts/${encodeURIComponent('old work')}`,
      { method: 'DELETE' },
    ))

    expect(response.status).toBe(200)
    expect(spaced.status).toBe(200)
    expect(manager.removeAccount.mock.calls).toEqual([['work'], ['old work']])
    expect(await response.json()).toMatchObject({
      schemaVersion: 1,
      baseHostname: 'localhost',
      defaultAccount: 'default',
      routingEnabled: true,
    })
  })
})

describe('Dashboard M365 and account-removal mutation guards', () => {
  const mutations: Array<{
    name: string
    path: string
    method: string
    body?: unknown
    managerMethod: (manager: ReturnType<typeof fakeManager>) => ReturnType<typeof mock>
  }> = [
    { name: 'register', path: '/dashboard/api/m365/register', method: 'POST', body: { hostname: 'm365.localhost' }, managerMethod: m => m.registerM365Target },
    { name: 'account', path: '/dashboard/api/m365/account', method: 'POST', body: { account: 'home' }, managerMethod: m => m.configureM365Target },
    { name: 'hostname', path: '/dashboard/api/m365/hostname', method: 'POST', body: { hostname: 'm365.localhost' }, managerMethod: m => m.configureM365Target },
    { name: 'remove account', path: '/dashboard/api/accounts/work', method: 'DELETE', managerMethod: m => m.removeAccount },
  ]

  for (const mutation of mutations) {
    test(`${mutation.name}: reports 409 without account management`, async () => {
      const response = await createDashboardRoutes()
        .handle(dashboardRequest(mutation.path, { method: mutation.method, body: mutation.body }))

      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        error: {
          message: 'Account management is unavailable for this process configuration.',
          type: 'invalid_request_error',
        },
      })
    })

    test(`${mutation.name}: rejects a cross-origin request before reaching the manager`, async () => {
      const manager = fakeManager()
      const response = await createDashboardRoutes({ accountManager: manager })
        .handle(dashboardRequest(mutation.path, {
          method: mutation.method,
          body: mutation.body,
          origin: 'https://attacker.example',
        }))

      expect(response.status).toBe(403)
      expect(mutation.managerMethod(manager)).not.toHaveBeenCalled()
    })

    test(`${mutation.name}: maps manager failures to their status or a generic 500`, async () => {
      const manager = fakeManager()
      const app = createDashboardRoutes({ accountManager: manager })
      const managerMethod = mutation.managerMethod(manager)

      managerMethod.mockImplementationOnce(async () => {
        throw new AccountManagementError('Account "work" was not found.', 404)
      })
      const known = await app.handle(dashboardRequest(mutation.path, { method: mutation.method, body: mutation.body }))
      managerMethod.mockImplementationOnce(async () => {
        throw new Error('private failure detail')
      })
      const unknown = await app.handle(dashboardRequest(mutation.path, { method: mutation.method, body: mutation.body }))

      expect(known.status).toBe(404)
      expect(await known.json()).toMatchObject({ error: { message: 'Account "work" was not found.' } })
      expect(unknown.status).toBe(500)
      const unknownBody = await unknown.text()
      expect(JSON.parse(unknownBody)).toMatchObject({ error: { message: 'Account management request failed.' } })
      expect(unknownBody).not.toContain('private failure detail')
    })
  }
})
