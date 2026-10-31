import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, test } from 'bun:test'

import {
  getMscToken,
  listMscAccounts,
  MscAuthError,
  resetMscTokenCache,
  resolveMscAuthExe,
  setMscHelperRunner,
} from '~/clients/msc-auth'

const temporaryDirs: Array<string> = []
const originalExe = process.env.GHC_MSC_AUTH_EXE
const THIRTY_MINUTES = 30 * 60 * 1000

function makeFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'msc-auth-test-'))
  temporaryDirs.push(dir)
  const file = join(dir, 'msc-auth.exe')
  writeFileSync(file, contents)
  chmodSync(file, 0o755)
  return file
}

function fakeRunner(stdout: string, code = 0, stderr = '') {
  return async () => ({ stdout, stderr, code })
}

function payload(expiresInMs = THIRTY_MINUTES, accessToken = 'token-value'): string {
  return JSON.stringify({
    access_token: accessToken,
    expires_on: new Date(Date.now() + expiresInMs).toISOString(),
    tenant: 'tenant-id',
  })
}

afterEach(() => {
  if (originalExe === undefined) {
    delete process.env.GHC_MSC_AUTH_EXE
  }
  else {
    process.env.GHC_MSC_AUTH_EXE = originalExe
  }
  setMscHelperRunner()
  resetMscTokenCache()
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveMscAuthExe', () => {
  test('prefers an explicit path over the environment override', () => {
    const explicit = makeFile('#!/bin/sh\nexit 0\n')
    process.env.GHC_MSC_AUTH_EXE = makeFile('#!/bin/sh\nexit 0\n')
    expect(resolveMscAuthExe(explicit)).toBe(explicit)
  })

  test('falls back to GHC_MSC_AUTH_EXE when no explicit path is given', () => {
    const fromEnv = makeFile('#!/bin/sh\nexit 0\n')
    process.env.GHC_MSC_AUTH_EXE = fromEnv
    expect(resolveMscAuthExe()).toBe(fromEnv)
  })
})

describe('getMscToken', () => {
  test('parses the helper payload', async () => {
    process.env.GHC_MSC_AUTH_EXE = makeFile('unused')
    setMscHelperRunner(fakeRunner(payload()))

    const token = await getMscToken()
    expect(token.accessToken).toBe('token-value')
    expect(token.tenant).toBe('tenant-id')
    expect(token.expiresOn.getTime()).toBeGreaterThan(Date.now())
  })

  test('surfaces the helper exit code and diagnostics', async () => {
    process.env.GHC_MSC_AUTH_EXE = makeFile('unused')
    setMscHelperRunner(
      fakeRunner('', 2, '[msc-auth] no account matched\n[msal:Error] noise'),
    )

    const failure = await getMscToken().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(MscAuthError)
    expect((failure as MscAuthError).code).toBe(2)
    expect((failure as MscAuthError).message).toContain('no account matched')
  })

  test('rejects unusable output', async () => {
    process.env.GHC_MSC_AUTH_EXE = makeFile('unused')
    setMscHelperRunner(fakeRunner('not json'))

    await expect(getMscToken()).rejects.toThrow(MscAuthError)
  })

  test('reuses the cached token until it nears expiry', async () => {
    process.env.GHC_MSC_AUTH_EXE = makeFile('unused')
    let calls = 0
    setMscHelperRunner(async () => {
      calls += 1
      return { stdout: payload(), stderr: '', code: 0 }
    })

    const first = await getMscToken()
    const second = await getMscToken()

    expect(second.accessToken).toBe(first.accessToken)
    expect(calls).toBe(1)
  })

  test('re-acquires when the cached token is inside the refresh window', async () => {
    process.env.GHC_MSC_AUTH_EXE = makeFile('unused')
    let calls = 0
    setMscHelperRunner(async () => {
      calls += 1
      return { stdout: payload(60_000, `token-${calls}`), stderr: '', code: 0 }
    })

    const first = await getMscToken()
    const second = await getMscToken()

    expect(first.accessToken).toBe('token-1')
    expect(second.accessToken).toBe('token-2')
  })

  test('shares one acquisition between concurrent callers', async () => {
    process.env.GHC_MSC_AUTH_EXE = makeFile('unused')
    let calls = 0
    setMscHelperRunner(async () => {
      calls += 1
      return { stdout: payload(), stderr: '', code: 0 }
    })

    await Promise.all([getMscToken(), getMscToken(), getMscToken()])
    expect(calls).toBe(1)
  })

  test('keeps tokens for different credential identities apart', async () => {
    process.env.GHC_MSC_AUTH_EXE = makeFile('unused')
    let calls = 0
    setMscHelperRunner(async (_exe, args) => {
      calls += 1
      const index = args.indexOf('--account')
      const account = index >= 0 ? args[index + 1] : 'default'
      return { stdout: payload(THIRTY_MINUTES, `token-${account}`), stderr: '', code: 0 }
    })

    const first = await getMscToken({ account: 'account-a' })
    const second = await getMscToken({ account: 'account-b' })
    const again = await getMscToken({ account: 'account-a' })

    expect(second.accessToken).toBe('token-account-b')
    expect(again).toBe(first)
    expect(calls).toBe(2)
  })
})

describe('listMscAccounts', () => {
  test('parses the tab-separated account listing', async () => {
    process.env.GHC_MSC_AUTH_EXE = makeFile('unused')
    setMscHelperRunner(fakeRunner(
      'user@example.com\tuid.utid\tlogin.microsoftonline.com\n'
      + 'other@example.com\tuid2.utid2\tlogin.microsoftonline.com\n',
    ))

    expect(await listMscAccounts()).toEqual([
      { upn: 'user@example.com', homeAccountId: 'uid.utid', environment: 'login.microsoftonline.com' },
      { upn: 'other@example.com', homeAccountId: 'uid2.utid2', environment: 'login.microsoftonline.com' },
    ])
  })

  test('surfaces a helper failure', async () => {
    process.env.GHC_MSC_AUTH_EXE = makeFile('unused')
    setMscHelperRunner(fakeRunner('', 3, '[msc-auth] broker unavailable'))

    await expect(listMscAccounts()).rejects.toThrow(MscAuthError)
  })
})

// Exercises the real execFile path through a shell script, which Windows cannot
// run directly; the spawn failure itself is covered by the injected-runner cases.
describe.skipIf(process.platform === 'win32')('getMscToken via execFile', () => {
  test('spawns the helper and parses its stdout', async () => {
    process.env.GHC_MSC_AUTH_EXE = makeFile(
      `#!/bin/sh\nprintf '%s\\n' '${payload()}'\n`,
    )

    const token = await getMscToken()
    expect(token.accessToken).toBe('token-value')
  })
})
