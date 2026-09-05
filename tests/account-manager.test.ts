import type {
  AccountManagerDependencies,
  AccountManagerPersistence,
} from '~/accounts/manager'

import type { AccountRuntime } from '~/state'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { AccountManager } from '~/accounts/manager'
import { compileAccountRouting } from '~/lib/account-routing'
import {
  configureAccountRuntimes,
  createAccountRuntime,
  resetAccountRuntimes,
  resolveRequestAccountRuntime,
} from '~/state'

function runtime(name: string, login: string, token = `github-${name}`): AccountRuntime {
  const value = createAccountRuntime(name)
  value.auth.githubToken = token
  value.auth.copilotToken = `copilot-${name}`
  value.auth.githubLogin = login
  value.auth.githubValidatedAt = 1_000
  value.auth.copilotTokenExpiresAt = Date.now() + 60_000
  value.auth.copilotTokenLastRefreshAt = 2_000
  value.auth.copilotTokenLastRefreshSucceeded = true
  value.models.cacheModels({ object: 'list', data: [] })
  return value
}

function initialState() {
  const defaultRuntime = runtime('default', 'alice')
  const account1Runtime = runtime('account1', 'bob')
  const routing = compileAccountRouting({
    baseHostname: 'localhost',
    defaultAccount: 'default',
    hostnames: {
      'default.localhost': 'default',
      'account1.localhost': 'account1',
    },
  }, ['default', 'account1'])
  const runtimes = [defaultRuntime, account1Runtime]
  configureAccountRuntimes(routing, runtimes)
  return { routing, runtimes }
}

function dependencies(overrides: Partial<AccountManagerDependencies> = {}) {
  const persistence: AccountManagerPersistence = {
    addAccount: async (_input, applyRuntime) => applyRuntime(),
    setDefault: async (_routing, applyRuntime) => applyRuntime(),
  }
  return {
    beginAuthentication: async () => {
      const added = runtime('account2', 'carol')
      return {
        authorization: {
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
          expiresAt: '2026-09-05T12:00:00.000Z',
          pollIntervalSeconds: 5,
        },
        completion: Promise.resolve({
          githubToken: 'github-account2',
          runtime: added,
          stopRefresh: mock(() => {}),
        }),
      }
    },
    createSessionId: () => 'session-1',
    persistence,
    projectAccount: async descriptor => ({
      name: descriptor.name,
      hostname: descriptor.hostname,
      isDefault: descriptor.isDefault,
      tenant: descriptor.runtime.auth.gheDomain ?? 'github.com',
      github: {
        status: 'ok' as const,
        login: descriptor.runtime.auth.githubLogin,
        lastValidatedAt: '1970-01-01T00:00:01.000Z',
        accountType: descriptor.runtime.auth.accountType,
      },
      copilot: {
        status: 'ok' as const,
        modelsLoaded: true,
        expiresAt: '2099-01-01T00:00:00.000Z',
        lastRefreshAt: '1970-01-01T00:00:02.000Z',
        lastRefreshSucceeded: true,
      },
      quota: { status: 'unavailable' as const },
    }),
    ...overrides,
  } satisfies AccountManagerDependencies
}

beforeEach(() => resetAccountRuntimes())
afterEach(() => resetAccountRuntimes())

describe('AccountManager', () => {
  test('lists safe account identity and stable dedicated hostnames', async () => {
    const state = initialState()
    const manager = new AccountManager(state, dependencies())

    const accounts = await manager.listAccounts()

    expect(accounts.map(account => ({
      name: account.name,
      hostname: account.hostname,
      isDefault: account.isDefault,
      login: account.github.login,
    }))).toEqual([
      { name: 'account1', hostname: 'account1.localhost', isDefault: false, login: 'bob' },
      { name: 'default', hostname: 'default.localhost', isDefault: true, login: 'alice' },
    ])
    expect(JSON.stringify(accounts)).not.toContain('github-default')
    expect(JSON.stringify(accounts)).not.toContain('copilot-default')
  })

  test('adds an authenticated account only after persistence and installs its exact route', async () => {
    const state = initialState()
    const addAccount = mock(async (_input, applyRuntime: () => void) => applyRuntime())
    const manager = new AccountManager(state, dependencies({
      persistence: {
        addAccount,
        setDefault: async (_routing, applyRuntime) => applyRuntime(),
      },
    }))

    const session = await manager.beginAddAccount({
      accountName: 'account2',
      hostname: 'account2.localhost',
    })
    const completed = await manager.waitForAuthentication(session.id)

    expect(session).toMatchObject({
      id: 'session-1',
      state: 'pending',
      accountName: 'account2',
      hostname: 'account2.localhost',
      authorization: { userCode: 'ABCD-1234' },
    })
    expect(JSON.stringify(session)).not.toContain('github-account2')
    expect(completed).toMatchObject({ state: 'succeeded' })
    expect(addAccount).toHaveBeenCalledTimes(1)
    expect(resolveRequestAccountRuntime(new Request('http://account2.localhost/token'))?.name)
      .toBe('account2')
    expect(resolveRequestAccountRuntime(new Request('http://unknown.localhost/token')))
      .toBeUndefined()
  })

  test('authentication failure does not persist or install an account', async () => {
    const state = initialState()
    const addAccount = mock(async (_input, applyRuntime: () => void) => applyRuntime())
    const manager = new AccountManager(state, dependencies({
      beginAuthentication: async () => ({
        authorization: {
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
          expiresAt: '2026-09-05T12:00:00.000Z',
          pollIntervalSeconds: 5,
        },
        completion: Promise.reject(new Error('raw secret upstream failure')),
      }),
      persistence: {
        addAccount,
        setDefault: async (_routing, applyRuntime) => applyRuntime(),
      },
    }))

    const session = await manager.beginAddAccount({
      accountName: 'account2',
      hostname: 'account2.localhost',
    })
    const failed = await manager.waitForAuthentication(session.id)

    expect(failed).toMatchObject({
      state: 'failed',
      message: 'Account authentication failed.',
    })
    expect(JSON.stringify(failed)).not.toContain('raw secret')
    expect(addAccount).not.toHaveBeenCalled()
    expect(resolveRequestAccountRuntime(new Request('http://account2.localhost/token')))
      .toBeUndefined()
  })

  test('persistence failure stops refresh and leaves routing unchanged', async () => {
    const state = initialState()
    const stopRefresh = mock(() => {})
    const manager = new AccountManager(state, dependencies({
      beginAuthentication: async () => ({
        authorization: {
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
          expiresAt: '2026-09-05T12:00:00.000Z',
          pollIntervalSeconds: 5,
        },
        completion: Promise.resolve({
          githubToken: 'private-token',
          runtime: runtime('account2', 'carol', 'private-token'),
          stopRefresh,
        }),
      }),
      persistence: {
        addAccount: async () => {
          throw new Error('disk failed with private-token')
        },
        setDefault: async (_routing, applyRuntime) => applyRuntime(),
      },
    }))

    const session = await manager.beginAddAccount({
      accountName: 'account2',
      hostname: 'account2.localhost',
    })
    const failed = await manager.waitForAuthentication(session.id)

    expect(failed).toMatchObject({
      state: 'failed',
      message: 'Account authentication failed.',
    })
    expect(stopRefresh).toHaveBeenCalledTimes(1)
    expect(resolveRequestAccountRuntime(new Request('http://account2.localhost/token')))
      .toBeUndefined()
  })

  test('switches the base hostname without changing dedicated hostname routes', async () => {
    const state = initialState()
    const manager = new AccountManager(state, dependencies())

    await manager.setDefaultAccount('account1')

    expect(resolveRequestAccountRuntime(new Request('http://localhost/token'))?.name)
      .toBe('account1')
    expect(resolveRequestAccountRuntime(new Request('http://default.localhost/token'))?.name)
      .toBe('default')
    expect(resolveRequestAccountRuntime(new Request('http://account1.localhost/token'))?.name)
      .toBe('account1')
  })

  test('failed default persistence preserves the previous default', async () => {
    const state = initialState()
    const manager = new AccountManager(state, dependencies({
      persistence: {
        addAccount: async (_input, applyRuntime) => applyRuntime(),
        setDefault: async () => {
          throw new Error('disk failure')
        },
      },
    }))

    await expect(manager.setDefaultAccount('account1')).rejects.toThrow('disk failure')
    expect(resolveRequestAccountRuntime(new Request('http://localhost/token'))?.name)
      .toBe('default')
  })

  test('rejects duplicate names and hostnames while another authentication is pending', async () => {
    const state = initialState()
    let finish!: (value: {
      githubToken: string
      runtime: AccountRuntime
      stopRefresh: () => void
    }) => void
    const completion = new Promise<{
      githubToken: string
      runtime: AccountRuntime
      stopRefresh: () => void
    }>((resolve) => {
      finish = resolve
    })
    const manager = new AccountManager(state, dependencies({
      beginAuthentication: async () => ({
        authorization: {
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
          expiresAt: '2026-09-05T12:00:00.000Z',
          pollIntervalSeconds: 5,
        },
        completion,
      }),
    }))

    const session = await manager.beginAddAccount({
      accountName: 'account2',
      hostname: 'account2.localhost',
    })
    await expect(manager.beginAddAccount({
      accountName: 'account2',
      hostname: 'other.localhost',
    })).rejects.toThrow('already exists or is being authenticated')
    await expect(manager.beginAddAccount({
      accountName: 'other',
      hostname: 'account2.localhost',
    })).rejects.toThrow('already configured or reserved')

    finish({
      githubToken: 'github-account2',
      runtime: runtime('account2', 'carol'),
      stopRefresh: () => {},
    })
    await manager.waitForAuthentication(session.id)
  })
})
