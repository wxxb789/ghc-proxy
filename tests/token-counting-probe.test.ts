import { describe, expect, test } from 'bun:test'
import { runTokenCountingProbe } from '../scripts/probes/token-counting'

const options = {
  live: false,
  account: 'probe-account',
  accountType: 'enterprise' as const,
  vsCodeVersion: '1.104.3',
  messagesModels: ['claude-probe'],
  responsesModels: ['gpt-probe'],
  maxRequests: 10,
}

interface StopCase {
  name: string
  input: number
  expected: number
}

interface InvalidCountCase {
  name: string
  input: unknown
  expected: string
}

const stopCases: StopCase[] = [
  { name: 'unauthorized', input: 401, expected: 3 },
  { name: 'forbidden', input: 403, expected: 3 },
  { name: 'rate limited', input: 429, expected: 3 },
]

const invalidCountCases: InvalidCountCase[] = [
  { name: 'negative', input: -1, expected: 'unmeasured' },
  { name: 'fractional', input: 1.5, expected: 'unmeasured' },
  { name: 'string', input: '42', expected: 'unmeasured' },
  { name: 'null', input: null, expected: 'unmeasured' },
]

function fixture(status = 200, count: unknown = 42) {
  const calls: Array<{ url: string, init?: RequestInit }> = []
  let credentialReads = 0
  const deps = {
    readCredential: async () => {
      credentialReads++
      return { accountName: 'probe-account', githubToken: 'github-test-secret' }
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/copilot_internal/v2/token'))
        return Response.json({ token: 'copilot-test-secret', endpoints: { api: 'https://api.enterprise.githubcopilot.com' } })
      if (url.endsWith('/models'))
        return Response.json({ data: [{ id: 'claude-probe' }, { id: 'gpt-probe' }] })
      const body = JSON.parse(String(init?.body)) as { model?: unknown }
      if (typeof body.model === 'number')
        return Response.json({ error: { message: 'invalid model' } }, { status: 400 })
      return Response.json({ input_tokens: count }, { status })
    }) as typeof fetch,
  }
  return { calls, deps, reads: () => credentialReads }
}

describe('bounded token counting probe', () => {
  test('dry-run performs no credential reads or HTTP requests', async () => {
    const mock = fixture()
    const result = await runTokenCountingProbe(options, mock.deps)
    expect(result.mode).toBe('dry-run')
    expect(result.requests).toBe(0)
    expect(result.plannedRequests).toBe(10)
    expect(mock.reads()).toBe(0)
    expect(mock.calls).toEqual([])
  })

  test('rejects insufficient budgets before reading credentials', async () => {
    const mock = fixture()
    await expect(runTokenCountingProbe({ ...options, live: true, maxRequests: 9 }, mock.deps)).rejects.toThrow('exceed')
    expect(mock.reads()).toBe(0)
    expect(mock.calls).toEqual([])
  })

  test('counts every HTTP operation and never sends generation requests or exposes credentials', async () => {
    const mock = fixture()
    const result = await runTokenCountingProbe({ ...options, live: true }, mock.deps)
    expect(result.requests).toBe(10)
    expect(mock.calls).toHaveLength(10)
    const allowedPaths = new Set(['/copilot_internal/v2/token', '/models', '/v1/messages/count_tokens', '/responses/input_tokens'])
    expect(mock.calls.every(call => allowedPaths.has(new URL(call.url).pathname))).toBe(true)
    expect(mock.calls.every(call => call.init?.redirect === 'error' && call.init.signal instanceof AbortSignal)).toBe(true)
    const report = JSON.stringify(result)
    expect(report).not.toContain('github-test-secret')
    expect(report).not.toContain('copilot-test-secret')
    if (result.mode !== 'live')
      throw new Error('Expected live probe result')
    expect(result.rows.filter(row => row.name === 'invalid-model-type').map(row => row.verdict))
      .toEqual(['negative-control-rejected', 'negative-control-rejected'])
    expect(result.rows.filter(row => row.name !== 'invalid-model-type')).toHaveLength(6)
    expect(result.rows.filter(row => row.name !== 'invalid-model-type').every(row => row.verdict === 'count-returned')).toBe(true)
    expect(result.g1a).toBe('not-established-by-this-screen')
  })

  test('404 stops the remaining cases for that model and endpoint', async () => {
    const mock = fixture(404)
    const result = await runTokenCountingProbe({ ...options, live: true }, mock.deps)
    expect(result.requests).toBe(4)
    if (result.mode !== 'live')
      throw new Error('Expected live probe result')
    expect(result.rows.map(row => [row.model, row.verdict])).toEqual([
      ['claude-probe', 'not-found'],
      ['claude-probe', 'not-tested-after-404'],
      ['claude-probe', 'not-tested-after-404'],
      ['claude-probe', 'not-tested-after-404'],
      ['gpt-probe', 'not-found'],
      ['gpt-probe', 'not-tested-after-404'],
      ['gpt-probe', 'not-tested-after-404'],
      ['gpt-probe', 'not-tested-after-404'],
    ])
  })

  test('absent models are reported without substituting another model or sending count requests', async () => {
    const mock = fixture()
    const result = await runTokenCountingProbe({
      ...options,
      live: true,
      messagesModels: ['missing-claude'],
      responsesModels: ['missing-gpt'],
    }, mock.deps)
    expect(result.requests).toBe(2)
    expect(mock.calls).toHaveLength(2)
    if (result.mode !== 'live')
      throw new Error('Expected live probe result')
    expect(result.rows).toHaveLength(8)
    expect(result.rows.every(row => row.verdict === 'model-not-advertised')).toBe(true)
  })

  test.each(stopCases)('$name response stops the screen without retries', async ({ input, expected }) => {
    const mock = fixture(input)
    const result = await runTokenCountingProbe({ ...options, live: true }, mock.deps)
    expect(result.requests).toBe(expected)
  })

  test.each(invalidCountCases)('$name count is not recorded as successful', async ({ input, expected }) => {
    const mock = fixture(200, input)
    const result = await runTokenCountingProbe({ ...options, live: true }, mock.deps)
    if (result.mode !== 'live')
      throw new Error('Expected live probe result')
    expect(result.rows.filter(row => row.name !== 'invalid-model-type').map(row => row.verdict))
      .toEqual(Array.from<string>({ length: 6 }).fill(expected))
  })
})
