import type { ClientConfig } from '~/clients/types'
import type { GitHubCredential } from '~/lib/credentials'

import process from 'node:process'
import { parseArgs } from 'node:util'
import { copilotBaseUrl, copilotHeaders, githubHeaders } from '~/clients/api-config'
import { buildGitHubUrls } from '~/clients/ghe-domain'
import { readGitHubCredential } from '~/lib/credentials'

const COUNT_ENDPOINTS = {
  messages: '/v1/messages/count_tokens',
  responses: '/responses/input_tokens',
} as const
type CountEndpoint = typeof COUNT_ENDPOINTS[keyof typeof COUNT_ENDPOINTS]

export interface TokenCountingProbeOptions {
  live: boolean
  account: string
  accountType: ClientConfig['accountType']
  vsCodeVersion: string
  messagesModels: Array<string>
  responsesModels: Array<string>
  maxRequests: number
}

interface ProbeDeps {
  fetch: typeof fetch
  readCredential: (account: string) => Promise<GitHubCredential | undefined>
}

interface CountCase {
  name: string
  endpoint: CountEndpoint
  model: string
  body: Record<string, unknown>
  negativeControl?: boolean
}

function casesFor(endpoint: CountEndpoint, model: string): Array<CountCase> {
  const text = 'Count this synthetic input without generating a completion.'
  const input = (content: string) => endpoint === COUNT_ENDPOINTS.messages
    ? { messages: [{ role: 'user', content }] }
    : { input: [{ type: 'message', role: 'user', content }] }
  const tool = endpoint === COUNT_ENDPOINTS.messages
    ? { name: 'lookup', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }
    : { type: 'function', name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } }
  return [
    { name: 'text', endpoint, model, body: { model, ...input(text) } },
    { name: 'longer-text', endpoint, model, body: { model, ...input(text.repeat(20)) } },
    {
      name: 'instructions-and-tool',
      endpoint,
      model,
      body: {
        model,
        ...input(text),
        [endpoint === COUNT_ENDPOINTS.messages ? 'system' : 'instructions']: 'Use the lookup tool when necessary.',
        tools: [tool],
      },
    },
    { name: 'invalid-model-type', endpoint, model, body: { model: 123, ...input(text) }, negativeControl: true },
  ]
}

export async function runTokenCountingProbe(options: TokenCountingProbeOptions, deps: ProbeDeps = {
  fetch,
  readCredential: account => readGitHubCredential(undefined, account),
}) {
  if (!options.account.trim() || !options.vsCodeVersion.trim())
    throw new Error('An explicit account and VS Code version are required.')
  if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 2 || options.maxRequests > 100)
    throw new Error('maxRequests must be an integer between 2 and 100, including authentication and model inventory.')
  const cases = [
    ...options.messagesModels.flatMap(model => casesFor(COUNT_ENDPOINTS.messages, model)),
    ...options.responsesModels.flatMap(model => casesFor(COUNT_ENDPOINTS.responses, model)),
  ]
  if (cases.length === 0 || cases.some(entry => !entry.model.trim()))
    throw new Error('At least one explicit model is required.')
  const summary = {
    account: options.account,
    maxRequests: options.maxRequests,
    plannedRequests: cases.length + 2,
    generationRequests: 0,
    cases: cases.map(({ body: _body, ...entry }) => entry),
    coverage: 'Initial text/tool capability screen only; multimodal and client compatibility still require verification.',
  }
  if (!options.live)
    return { ...summary, mode: 'dry-run' as const, requests: 0 }
  if (summary.plannedRequests > options.maxRequests)
    throw new Error('Planned requests exceed the explicit budget. Reduce the model list or raise maxRequests.')

  const credential = await deps.readCredential(options.account)
  if (!credential)
    throw new Error('No stored credential is available for the selected account.')
  const urls = buildGitHubUrls(credential.gheDomain)
  const config: ClientConfig = {
    accountType: credential.gheDomain ? 'enterprise' : options.accountType,
    vsCodeVersion: options.vsCodeVersion,
  }
  let requests = 0
  const requestJson = async (url: string, init: RequestInit) => {
    if (requests >= options.maxRequests)
      throw new Error('Request budget exhausted.')
    requests++
    const response = await deps.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) })
    const data: unknown = await response.json().catch((error: unknown) => {
      if (error instanceof SyntaxError)
        return null
      throw error
    })
    return { status: response.status, data }
  }
  const auth = await requestJson(`${urls.apiBaseUrl}/copilot_internal/v2/token`, {
    headers: githubHeaders({ githubToken: credential.githubToken }, config),
  })
  const session = asRecord(auth.data)
  if (auth.status !== 200 || typeof session?.token !== 'string' || !session.token)
    throw new Error(`Copilot session acquisition failed (HTTP ${auth.status}); no count requests sent.`)
  const api = asRecord(session.endpoints)?.api
  if (typeof api === 'string') {
    const url = new URL(api)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('The session returned an invalid API base URL.')
    config.copilotApiBase = api
  }
  const copilotToken = session.token
  const headers = () => copilotHeaders({ copilotToken }, config, { initiator: 'agent' })
  const base = copilotBaseUrl(config)
  const inventory = await requestJson(`${base}/models`, { headers: headers() })
  const models = asRecord(inventory.data)?.data
  if (inventory.status !== 200 || !Array.isArray(models))
    throw new Error(`Model inventory failed (HTTP ${inventory.status}); no count requests sent.`)
  const modelIds = new Set(models.map(model => asRecord(model)?.id))
  const rows = []
  const notFound = new Set<string>()
  for (const entry of cases) {
    if (!modelIds.has(entry.model)) {
      rows.push({ name: entry.name, endpoint: entry.endpoint, model: entry.model, verdict: 'model-not-advertised' })
      continue
    }
    const key = `${entry.endpoint}:${entry.model}`
    if (notFound.has(key)) {
      rows.push({ name: entry.name, endpoint: entry.endpoint, model: entry.model, verdict: 'not-tested-after-404' })
      continue
    }
    const started = performance.now()
    const response = await requestJson(`${base}${entry.endpoint}`, {
      method: 'POST',
      headers: { ...headers(), ...(entry.endpoint === COUNT_ENDPOINTS.messages ? { 'anthropic-version': '2023-06-01' } : {}) },
      body: JSON.stringify(entry.body),
    })
    const count = asRecord(response.data)?.input_tokens
    const validCount = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
    const verdict = entry.negativeControl
      ? response.status === 400 || response.status === 422 ? 'negative-control-rejected' : 'negative-control-inconclusive'
      : response.status === 200 && validCount ? 'count-returned' : response.status === 404 ? 'not-found' : 'unmeasured'
    rows.push({
      name: entry.name,
      endpoint: entry.endpoint,
      model: entry.model,
      status: response.status,
      verdict,
      elapsedMs: Math.round(performance.now() - started),
      ...(response.status === 200 && validCount ? { inputTokens: count } : {}),
    })
    if (response.status === 404)
      notFound.add(key)
    if (response.status === 401 || response.status === 403 || response.status === 429)
      break
  }
  return {
    ...summary,
    mode: 'live' as const,
    date: new Date().toISOString(),
    requests,
    inventory: models.map((model) => {
      const value = asRecord(model)
      return { id: value?.id, supportedEndpoints: value?.supported_endpoints, tokenizer: asRecord(value?.capabilities)?.tokenizer }
    }),
    rows,
    g1a: 'not-established-by-this-screen',
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'live': { type: 'boolean', default: false },
      'account': { type: 'string' },
      'account-type': { type: 'string', default: 'individual' },
      'vscode-version': { type: 'string' },
      'messages-models': { type: 'string' },
      'responses-models': { type: 'string' },
      'max-requests': { type: 'string' },
    },
  })
  try {
    const accountType = values['account-type']
    if (accountType !== 'individual' && accountType !== 'business' && accountType !== 'enterprise')
      throw new Error('Invalid account-type.')
    const result = await runTokenCountingProbe({
      live: values.live,
      account: values.account ?? '',
      accountType,
      vsCodeVersion: values['vscode-version'] ?? '',
      messagesModels: values['messages-models']?.split(',') ?? [],
      responsesModels: values['responses-models']?.split(',') ?? [],
      maxRequests: Number(values['max-requests']),
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }
  catch {
    process.stderr.write('Token-counting probe failed. Check explicit options, request budget, account credentials and network access. No retries or generation fallback were attempted.\n')
    process.exitCode = 1
  }
}
