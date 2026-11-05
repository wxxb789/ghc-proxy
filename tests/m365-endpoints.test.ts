import type { ConfigFile } from '~/lib/config'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { AccountManager, createAccountManagerPersistence } from '~/accounts/manager'
import { createTargetRuntime } from '~/accounts/target-runtime'
import { CopilotClient } from '~/clients'
import { getClientConfig } from '~/clients/factory'
import { resetMscTokenCache, setMscHelperRunner } from '~/clients/msc-auth'
import { compileAccountRouting } from '~/lib/account-routing'
import { getCachedConfig } from '~/lib/config'
import { PATHS } from '~/lib/paths'
import { createDashboardRoutes } from '~/routes/dashboard/route'
import { createAccountRuntime, resetAccountRuntimes, resolveRequestAccountRuntime, runWithAccountRuntime } from '~/state'

import { clearConfig } from './helpers'

const CUSTOM_ENDPOINT = 'https://gateway.example.test/api/v1/llmapi'
const MSIT_ENDPOINT = 'https://msit.loki.delve.office.com/api/v1/llmapi'
let savedConfig: ConfigFile
let helperDirectory: string
let helperExe: string

beforeEach(async () => {
  savedConfig = structuredClone(getCachedConfig())
  clearConfig()
  helperDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ghc-m365-helper-'))
  helperExe = path.join(helperDirectory, 'msc-auth.exe')
  await fs.writeFile(helperExe, 'unused')
  resetAccountRuntimes()
  resetMscTokenCache()
  setMscHelperRunner(async () => ({ stdout: '', stderr: '', code: 2 }))
})

afterEach(async () => {
  clearConfig()
  Object.assign(getCachedConfig(), savedConfig)
  resetAccountRuntimes()
  resetMscTokenCache()
  setMscHelperRunner(undefined)
  await fs.rm(helperDirectory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ghc-m365-endpoints-'))
  const paths = {
    ACCOUNT_MANAGEMENT_JOURNAL_PATH: path.join(directory, 'transaction.json'),
    CONFIG_PATH: path.join(directory, 'config.json'),
    CONFIG_MIGRATION_BACKUP_PATH: path.join(directory, 'config.backup'),
    CREDENTIALS_PATH: path.join(directory, 'credentials.json'),
  }
  const routing = {
    baseHostname: 'localhost',
    defaultAccount: 'default',
    hostnames: { 'default.localhost': 'default' },
  }
  await fs.writeFile(paths.CONFIG_PATH, JSON.stringify({ smallModel: 'preserved', accountRouting: routing }))
  const manager = new AccountManager({
    authDefaults: { mscAuthExe: helperExe },
    routing: compileAccountRouting(routing, ['default']),
    runtimes: [createAccountRuntime('default')],
  }, { persistence: createAccountManagerPersistence(paths) })
  const app = createDashboardRoutes({ accountManager: manager })
  const post = (body: unknown, origin = 'http://localhost') => app.handle(new Request('http://localhost/dashboard/api/m365/endpoint', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  }))
  return { directory, paths, manager, app, post }
}

describe('M365 endpoint configuration boundary', () => {
  test('saves before registration, restores selection, and retains it through account and target changes', async () => {
    const { directory, paths, manager, app, post } = await fixture()
    try {
      const initialState = await (await app.handle(new Request('http://localhost/dashboard/api/m365'))).json()
      expect(initialState).toMatchObject({
        endpoint: 'https://loki.delve.office.com/api/v1/llmapi',
        endpoints: expect.arrayContaining([
          'https://loki.delve.office.com/api/v1/llmapi',
          'https://df.loki.delve.office.com/api/v1/llmapi',
          MSIT_ENDPOINT,
        ]),
      })
      const response = await post({ endpoint: `${CUSTOM_ENDPOINT}/`, endpoints: [CUSTOM_ENDPOINT, `${CUSTOM_ENDPOINT}/`] })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ registered: false, endpoint: CUSTOM_ENDPOINT, endpoints: expect.arrayContaining([CUSTOM_ENDPOINT, MSIT_ENDPOINT]) })
      const persisted = JSON.parse(await fs.readFile(paths.CONFIG_PATH, 'utf8')) as ConfigFile
      expect(persisted).toMatchObject({ smallModel: 'preserved', m365: { endpoint: CUSTOM_ENDPOINT, endpoints: [CUSTOM_ENDPOINT] } })
      await manager.registerM365Target({ account: 'first-account' })
      const original = resolveRequestAccountRuntime(new Request('http://m365.localhost/v1/messages'))!
      const heldRequest = runWithAccountRuntime(original, async () => {
        await manager.configureM365Target({ endpoint: MSIT_ENDPOINT })
        return getClientConfig()
      })
      expect((await heldRequest).m365Endpoint).toBe(CUSTOM_ENDPOINT)
      const switched = resolveRequestAccountRuntime(new Request('http://m365.localhost/v1/messages'))!
      expect(await runWithAccountRuntime(switched, () => getClientConfig().m365Endpoint)).toBe(MSIT_ENDPOINT)
      await manager.configureM365Target({ account: 'second-account', hostname: 'office.localhost' })
      await manager.removeM365Target()
      await manager.registerM365Target({})
      const state = await (await app.handle(new Request('http://localhost/dashboard/api/m365'))).json()
      expect(state).toMatchObject({ registered: true, endpoint: MSIT_ENDPOINT, endpoints: expect.arrayContaining([CUSTOM_ENDPOINT]) })
      expect((JSON.parse(await fs.readFile(paths.CONFIG_PATH, 'utf8')) as ConfigFile).m365).toMatchObject({ endpoint: MSIT_ENDPOINT, endpoints: [CUSTOM_ENDPOINT] })
      const restarted = createTargetRuntime('m365', 'm365')
      expect(await runWithAccountRuntime(restarted, () => getClientConfig().m365Endpoint)).toBe(MSIT_ENDPOINT)
    }
    finally {
      await manager.stop()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  test.each([
    { name: 'HTTP', endpoint: 'http://gateway.example.test/api' },
    { name: 'embedded credential', endpoint: 'https://user:password@gateway.example.test/api' },
    { name: 'query', endpoint: 'https://gateway.example.test/api?token=value' },
    { name: 'fragment', endpoint: 'https://gateway.example.test/api#fragment' },
    { name: 'malformed URL', endpoint: 'not-a-url' },
  ])('rejects $name without changing saved configuration', async ({ endpoint }) => {
    const { directory, paths, manager, post } = await fixture()
    try {
      const before = await fs.readFile(paths.CONFIG_PATH, 'utf8')
      expect((await post({ endpoint })).status).toBe(400)
      expect(await fs.readFile(paths.CONFIG_PATH, 'utf8')).toBe(before)
    }
    finally {
      await manager.stop()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  test('rejects cross-origin selection and leaves the committed endpoint intact on disk failure', async () => {
    const { directory, paths, manager, post } = await fixture()
    try {
      expect((await post({ endpoint: CUSTOM_ENDPOINT }, 'https://attacker.example')).status).toBe(403)
      await manager.registerM365Target({})
      const original = resolveRequestAccountRuntime(new Request('http://m365.localhost/v1/messages'))
      await fs.writeFile(paths.CONFIG_PATH, '{ invalid config')
      expect((await post({ endpoint: CUSTOM_ENDPOINT })).status).toBe(500)
      expect(resolveRequestAccountRuntime(new Request('http://m365.localhost/v1/messages'))).toBe(original)
      expect(await fs.readFile(paths.CONFIG_PATH, 'utf8')).toBe('{ invalid config')
    }
    finally {
      await manager.stop()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  test('preserves committed memory when the production config path contains an invalid disk edit', async () => {
    const { directory, paths, manager, post } = await fixture()
    const originalPath = PATHS.CONFIG_PATH
    try {
      PATHS.CONFIG_PATH = paths.CONFIG_PATH
      expect((await post({ endpoint: CUSTOM_ENDPOINT, endpoints: [CUSTOM_ENDPOINT, 'https://saved.example.test/api'] })).status).toBe(200)
      await manager.registerM365Target({})
      const committedConfig = structuredClone(getCachedConfig())
      const original = resolveRequestAccountRuntime(new Request('http://m365.localhost/v1/messages'))
      const diskEdit = JSON.stringify({ ...committedConfig, m365: { ...committedConfig.m365, endpoint: 'http://unsafe.example.test/api' } })
      await fs.writeFile(paths.CONFIG_PATH, diskEdit)

      expect((await post({ endpoint: MSIT_ENDPOINT })).status).toBe(500)
      expect(getCachedConfig()).toEqual(committedConfig)
      expect(await fs.readFile(paths.CONFIG_PATH, 'utf8')).toBe(diskEdit)
      expect(resolveRequestAccountRuntime(new Request('http://m365.localhost/v1/messages'))).toBe(original)
    }
    finally {
      PATHS.CONFIG_PATH = originalPath
      await manager.stop()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})

describe('M365 endpoint transport', () => {
  test.each([
    { name: 'default', endpoint: undefined, expected: 'https://loki.delve.office.com/api/v1/llmapi' },
    { name: 'MSIT', endpoint: MSIT_ENDPOINT, expected: MSIT_ENDPOINT },
    { name: 'custom', endpoint: CUSTOM_ENDPOINT, expected: CUSTOM_ENDPOINT },
  ])('uses $name for both model refresh and Messages', async ({ endpoint, expected }) => {
    setMscHelperRunner(async () => ({
      stdout: JSON.stringify({ access_token: 'test-token', expires_on: new Date(Date.now() + 3_600_000).toISOString(), tenant: 'test-tenant' }),
      stderr: '',
      code: 0,
    }))
    const runtime = createTargetRuntime('m365', 'm365', { m365Endpoint: endpoint, mscAuthExe: helperExe })
    const requests: Array<{ url: string, method: string, authorization: string | null }> = []
    await runWithAccountRuntime(runtime, async () => {
      const client = new CopilotClient(runtime.auth, getClientConfig(), {
        fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          requests.push({ url: String(input), method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') })
          return Response.json(String(input).endsWith('/models')
            ? { data: [{ id: 'claude-opus-5.5', supported_endpoints: ['/v1/messages'] }] }
            : { id: 'message', type: 'message', role: 'assistant', model: 'claude-opus-5.5', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
        }, { preconnect: fetch.preconnect }),
      })
      expect((await client.getModels()).data.map(model => model.id)).toEqual(['claude-opus-5.5'])
      const result = await client.createMessages({ model: 'claude-opus-5.5', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }], stream: false })
      expect(result).toMatchObject({ content: [{ type: 'text', text: 'hello' }] })
    })
    expect(requests).toEqual([
      { url: `${expected}/models`, method: 'GET', authorization: 'Bearer test-token' },
      { url: `${expected}/v1/messages`, method: 'POST', authorization: 'Bearer test-token' },
    ])
  })
})
