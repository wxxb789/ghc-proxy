import type {
  AccountManagerDependencies,
  AccountManagerPersistence,
} from '~/accounts/manager'

import type { AccountRuntime } from '~/state'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { AccountManager, createAccountManagerPersistence } from '~/accounts/manager'
import { compileAccountRouting } from '~/lib/account-routing'
import { readGitHubCredentials, writeGitHubCredential } from '~/lib/credentials'
import { createServer } from '~/server'
import {
  configureAccountRuntimes,
  createAccountRuntime,
  getCurrentAccountName,
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

    await expect(manager.setDefaultAccount('account1')).rejects.toThrow(
      'Could not switch the default account.',
    )
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

  test('rejects an invalid GHE tenant before starting authentication', async () => {
    const state = initialState()
    const beginAuthentication = mock(dependencies().beginAuthentication)
    const manager = new AccountManager(state, dependencies({ beginAuthentication }))

    await expect(manager.beginAddAccount({
      accountName: 'account2',
      hostname: 'account2.localhost',
      gheDomain: 'github.example.com',
    })).rejects.toThrow('Invalid GHE tenant.')
    expect(beginAuthentication).not.toHaveBeenCalled()
  })

  test('does not replace a stored account that is not currently routed', async () => {
    const state = initialState()
    const beginAuthentication = mock(dependencies().beginAuthentication)
    const manager = new AccountManager({
      ...state,
      knownAccountNames: ['default', 'account1', 'stored-only'],
    }, dependencies({ beginAuthentication }))

    await expect(manager.beginAddAccount({
      accountName: 'stored-only',
      hostname: 'stored.localhost',
    })).rejects.toThrow('already exists or is being authenticated')
    expect(beginAuthentication).not.toHaveBeenCalled()
  })

  test('persists an added account and default switch for restart without raw tokens', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghc-proxy-account-manager-'))
    const paths = {
      ACCOUNT_MANAGEMENT_JOURNAL_PATH: path.join(tempDir, 'account-management-transaction.json'),
      APP_DIR: tempDir,
      CONFIG_PATH: path.join(tempDir, 'config.json'),
      CONFIG_MIGRATION_BACKUP_PATH: path.join(tempDir, 'config.json.github-token-migration.bak'),
      CREDENTIALS_PATH: path.join(tempDir, 'credentials.json'),
    }
    try {
      await writeGitHubCredential('github-default', undefined, paths, 'default')
      await writeGitHubCredential('github-account1', undefined, paths, 'account1')
      const state = initialState()
      await fs.writeFile(paths.CONFIG_PATH, JSON.stringify({
        accountRouting: {
          baseHostname: state.routing.baseHostname,
          defaultAccount: state.routing.defaultAccount,
          hostnames: Object.fromEntries(state.routing.hostnames),
        },
      }))
      const manager = new AccountManager(state, dependencies({
        persistence: createAccountManagerPersistence(paths),
      }))

      const session = await manager.beginAddAccount({
        accountName: 'account2',
        hostname: 'account2.localhost',
      })
      expect(await manager.waitForAuthentication(session.id)).toMatchObject({
        state: 'succeeded',
      })
      await manager.setDefaultAccount('account2')

      const configContent = await fs.readFile(paths.CONFIG_PATH, 'utf8')
      const credentialsContent = await fs.readFile(paths.CREDENTIALS_PATH, 'utf8')
      const config = JSON.parse(configContent) as {
        accountRouting: {
          baseHostname: string
          defaultAccount: string
          hostnames: Record<string, string>
        }
      }
      const credentials = await readGitHubCredentials(paths)
      expect(config.accountRouting).toEqual({
        baseHostname: 'localhost',
        defaultAccount: 'account2',
        hostnames: {
          'default.localhost': 'default',
          'account1.localhost': 'account1',
          'account2.localhost': 'account2',
        },
      })
      expect(credentials?.accounts.account2).toMatchObject({
        accountName: 'account2',
        githubToken: 'github-account2',
      })
      expect(credentialsContent).not.toContain('github-account2')
      expect(configContent).not.toContain('github-account2')

      const restartedRouting = compileAccountRouting(
        config.accountRouting,
        Object.keys(credentials!.accounts),
      )
      configureAccountRuntimes(restartedRouting, [
        runtime('default', 'alice'),
        runtime('account1', 'bob'),
        runtime('account2', 'carol'),
      ])
      expect(resolveRequestAccountRuntime(new Request('http://localhost/token'))?.name)
        .toBe('account2')
      expect(resolveRequestAccountRuntime(new Request('http://default.localhost/token'))?.name)
        .toBe('default')
      expect(resolveRequestAccountRuntime(new Request('http://account1.localhost/token'))?.name)
        .toBe('account1')
      expect(resolveRequestAccountRuntime(new Request('http://account2.localhost/token'))?.name)
        .toBe('account2')
    }
    finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  test('keeps Dashboard mutations and routed HTTP identities consistent end to end', async () => {
    const state = initialState()
    const manager = new AccountManager(state, dependencies())
    const app = createServer({ accountManager: manager })

    const startResponse = await app.handle(new Request(
      'http://localhost/dashboard/api/accounts',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'origin': 'http://localhost',
        },
        body: JSON.stringify({
          accountName: 'account2',
          hostname: 'account2.localhost',
        }),
      },
    ))
    const authentication = await startResponse.json() as {
      authentication: { id: string }
    }
    await manager.waitForAuthentication(authentication.authentication.id)

    const account2 = await app.handle(new Request('http://account2.localhost/token'))
    const unknown = await app.handle(new Request('http://unknown.localhost/token'))
    const switchResponse = await app.handle(new Request(
      'http://localhost/dashboard/api/accounts/default',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'origin': 'http://localhost',
        },
        body: JSON.stringify({ accountName: 'account2' }),
      },
    ))
    const base = await app.handle(new Request('http://localhost/token'))
    const originalDefault = await app.handle(new Request('http://default.localhost/token'))

    expect(startResponse.status).toBe(202)
    expect(await account2.json()).toEqual({ token: 'copilot-account2' })
    expect(unknown.status).toBe(421)
    expect(switchResponse.status).toBe(200)
    expect(await base.json()).toEqual({ token: 'copilot-account2' })
    expect(await originalDefault.json()).toEqual({ token: 'copilot-default' })
  })

  test('does not change the account of an in-flight base-host request during a default switch', async () => {
    const state = initialState()
    const manager = new AccountManager(state, dependencies())
    const app = createServer({ accountManager: manager }).get('/__delayed-account', async () => {
      await Bun.sleep(20)
      return getCurrentAccountName()
    })

    const inFlight = Promise.resolve(
      app.handle(new Request('http://localhost/__delayed-account')),
    )
    await Bun.sleep(1)
    await manager.setDefaultAccount('account1')

    expect(await (await inFlight).text()).toBe('default')
    expect(await (await app.handle(new Request('http://localhost/token'))).json())
      .toEqual({ token: 'copilot-account1' })
  })

  test('bounds retained authentication sessions by evicting settled entries', async () => {
    const state = initialState()
    let nextSessionId = 0
    const manager = new AccountManager(state, dependencies({
      beginAuthentication: async ({ accountName }) => ({
        authorization: {
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
          expiresAt: '2026-09-05T12:00:00.000Z',
          pollIntervalSeconds: 5,
        },
        completion: Promise.resolve({
          githubToken: `github-${accountName}`,
          runtime: runtime(accountName, `${accountName}-user`),
          stopRefresh: () => {},
        }),
      }),
      createSessionId: () => `session-${++nextSessionId}`,
    }))

    for (let index = 0; index < 33; index++) {
      const session = await manager.beginAddAccount({
        accountName: `added-${index}`,
        hostname: `added-${index}.localhost`,
      })
      await manager.waitForAuthentication(session.id)
    }

    expect(manager.getAuthenticationSession('session-1')).toBeUndefined()
    expect(manager.getAuthenticationSession('session-33')).toMatchObject({
      state: 'succeeded',
    })
  })

  test('rejects authentication starts beyond the concurrent session limit', async () => {
    const state = initialState()
    let beginCalls = 0
    let nextSessionId = 0
    let releaseStarts!: () => void
    const startsBlocked = new Promise<void>((resolve) => {
      releaseStarts = resolve
    })
    const manager = new AccountManager(state, dependencies({
      beginAuthentication: async () => {
        beginCalls++
        if (beginCalls <= 32) {
          await startsBlocked
        }
        return {
          authorization: {
            userCode: 'ABCD-1234',
            verificationUri: 'https://github.com/login/device',
            expiresAt: '2026-09-05T12:00:00.000Z',
            pollIntervalSeconds: 5,
          },
          completion: Promise.reject(new Error('cancelled')),
        }
      },
      createSessionId: () => `session-${++nextSessionId}`,
    }))
    const pending = Array.from({ length: 32 }, (_, index) =>
      manager.beginAddAccount({
        accountName: `pending-${index}`,
        hostname: `pending-${index}.localhost`,
      }))
    await Promise.resolve()

    try {
      await expect(manager.beginAddAccount({
        accountName: 'overflow',
        hostname: 'overflow.localhost',
      })).rejects.toMatchObject({ status: 429 })
      expect(beginCalls).toBe(32)
    }
    finally {
      releaseStarts()
      await Promise.allSettled(pending)
      await manager.stop()
    }
  })

  test('aborts and waits for authentication that is still starting during shutdown', async () => {
    const state = initialState()
    let releaseDeviceCode!: () => void
    let signal: AbortSignal | undefined
    const beginAuthentication = mock(async (options: Parameters<AccountManagerDependencies['beginAuthentication']>[0]) => {
      signal = options.signal
      await new Promise<void>((resolve) => {
        releaseDeviceCode = resolve
      })
      options.signal?.throwIfAborted()
      throw new Error('unreachable')
    })
    const manager = new AccountManager(state, dependencies({ beginAuthentication }))

    const adding = manager.beginAddAccount({
      accountName: 'account2',
      hostname: 'account2.localhost',
    })
    await Promise.resolve()
    const stopping = manager.stop()

    expect(signal?.aborted).toBe(true)
    releaseDeviceCode()
    await expect(adding).rejects.toThrow('shutting down')
    await stopping
  })

  test('aborts pending authentication and runs existing refresh cleanup on shutdown', async () => {
    const state = initialState()
    const cleanupDefault = mock(() => {})
    const cleanupAccount1 = mock(() => {})
    const manager = new AccountManager({
      ...state,
      refreshCleanups: new Map([
        ['default', cleanupDefault],
        ['account1', cleanupAccount1],
      ]),
    }, dependencies({
      beginAuthentication: async options => ({
        authorization: {
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
          expiresAt: '2026-09-05T12:00:00.000Z',
          pollIntervalSeconds: 5,
        },
        completion: new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          )
        }),
      }),
    }))
    const session = await manager.beginAddAccount({
      accountName: 'account2',
      hostname: 'account2.localhost',
    })

    await manager.stop()

    expect(manager.getAuthenticationSession(session.id)).toMatchObject({
      state: 'failed',
    })
    expect(cleanupDefault).toHaveBeenCalledTimes(1)
    expect(cleanupAccount1).toHaveBeenCalledTimes(1)
  })
})
