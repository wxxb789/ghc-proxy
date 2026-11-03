import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createTargetRuntime } from '~/accounts/target-runtime'
import { resetMscTokenCache, setMscHelperRunner } from '~/clients/msc-auth'
import { compileAccountRouting } from '~/lib/account-routing'
import { enforceTargetGates } from '~/lib/target-gates'
import {
  configureAccountRuntimes,
  createAccountRuntime,
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
  })

  afterEach(() => {
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
    setTargetAvailability('m365', { status: 'unavailable', cause: 'no matching broker account' })

    const refusal = await runWithAccountRuntime(m365, () =>
      enforceTargetGates(requestTo('m365.localhost', '/dashboard'), loopbackServer))

    expect(refusal).toBeUndefined()
  })

  test('answers an unavailable target with its cause', async () => {
    const m365 = activate('m365-only')
    setTargetAvailability('m365', { status: 'unavailable', cause: 'no matching broker account' })
    setMscHelperRunner(async () => ({ stdout: '', stderr: '', code: 2 }))

    const refusal = await runWithAccountRuntime(m365, () =>
      enforceTargetGates(requestTo('m365.localhost', '/v1/messages'), loopbackServer))

    expect(refusal?.status).toBe(503)
    await expect(refusal!.json()).resolves.toMatchObject({
      type: 'error',
      error: { message: expect.stringContaining('unavailable') },
    })
  })

  test('recovers once the broker answers again', async () => {
    const m365 = activate('m365-only')
    setTargetAvailability('m365', { status: 'unavailable', cause: 'expired' })
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
  })
})
