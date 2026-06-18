/**
 * Shared utilities for probe scripts that send raw requests
 * to Copilot's upstream endpoints.
 */

import type { Model } from '~/types'

import process from 'node:process'
import consola from 'consola'
import { cacheModels, cacheVSCodeVersion, getClientConfig } from '~/clients/factory'
import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { getCachedConfig, readConfig } from '~/lib/config'
import { ensurePaths } from '~/lib/paths'
import { setupCopilotToken, setupGitHubToken } from '~/lib/token'
import { authStore } from '~/state'
import { MESSAGES_ENDPOINT, RESPONSES_ENDPOINT } from '~/transform/model-capabilities'

export const REQUEST_TIMEOUT_MS = 30_000

export interface ProbeResult {
  name: string
  extraFields: Record<string, unknown>
  status: 'accepted' | 'rejected' | 'error'
  httpStatus?: number
  errorMessage?: string
  note: string
}

export interface RawResponse {
  httpStatus: number
  text: string
  parsed: unknown
}

/**
 * Resolve the client-side abort timeout: honor the value chosen at bootstrap
 * (stored as upstreamTimeoutSeconds) so a probe bootstrapped at 120s does not
 * abort at the 30s default, falling back to the default when unset.
 */
function resolveTimeoutMs(override?: number): number {
  if (override != null)
    return override
  return (authStore.upstreamTimeoutSeconds || 0) * 1000 || REQUEST_TIMEOUT_MS
}

/**
 * Low-level POST to a Copilot upstream endpoint. Builds the URL + Copilot
 * headers, sends the JSON body, and returns the raw status/text/parsed triple.
 * The single source of truth for the raw-request plumbing the probe scripts
 * previously each reimplemented.
 */
export async function sendRaw(
  body: Record<string, unknown>,
  options?: { endpoint?: string, timeoutMs?: number },
): Promise<RawResponse> {
  const clientConfig = getClientConfig()
  const endpoint = options?.endpoint ?? MESSAGES_ENDPOINT
  const url = `${copilotBaseUrl(clientConfig)}${endpoint}`
  const headers = copilotHeaders(authStore, clientConfig, { initiator: 'agent' })

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(resolveTimeoutMs(options?.timeoutMs)),
  })

  const text = await response.text()
  return { httpStatus: response.status, text, parsed: tryParseJson(text) }
}

/**
 * Initialize state for probe scripts: silence logs, set config defaults,
 * then bootstrap tokens and model cache.
 */
export async function bootstrapProbe(options?: { silent?: boolean, timeoutMs?: number }): Promise<void> {
  consola.level = options?.silent ? Number.NEGATIVE_INFINITY : 0
  authStore.accountType = 'enterprise'
  authStore.manualApprove = false
  authStore.rateLimitWait = false
  authStore.showToken = false
  authStore.upstreamTimeoutSeconds = Math.floor((options?.timeoutMs ?? REQUEST_TIMEOUT_MS) / 1000)

  await ensurePaths()
  await readConfig()

  // Probe scripts must test actual models, not user-configured rewrites
  delete (getCachedConfig() as Record<string, unknown>).modelRewrites

  await cacheVSCodeVersion()
  await setupGitHubToken()
  await setupCopilotToken()
  await cacheModels()
}

/**
 * Send a raw request to Copilot's /v1/messages endpoint and return the result.
 */
export async function probeMessagesEndpoint(
  body: Record<string, unknown>,
  baseFields?: Record<string, unknown>,
): Promise<ProbeResult> {
  const extraFields: Record<string, unknown> = {}
  if (baseFields) {
    for (const [key, value] of Object.entries(body)) {
      if (!(key in baseFields)) {
        extraFields[key] = value
      }
    }
  }

  try {
    const { httpStatus, parsed } = await sendRaw(body)

    if (httpStatus >= 200 && httpStatus < 300) {
      return {
        name: '',
        extraFields,
        status: 'accepted',
        httpStatus,
        note: summarizeResponse(parsed),
      }
    }

    const errorMsg = extractErrorMessage(parsed)
    return {
      name: '',
      extraFields,
      status: 'rejected',
      httpStatus,
      errorMessage: errorMsg,
      note: errorMsg,
    }
  }
  catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      name: '',
      extraFields,
      status: 'error',
      errorMessage: msg,
      note: msg,
    }
  }
}

export function extractErrorMessage(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const err = (payload as { error?: { message?: string } }).error?.message
    if (err)
      return err
  }
  if (typeof payload === 'string')
    return payload.slice(0, 300)
  return JSON.stringify(payload).slice(0, 300)
}

function summarizeResponse(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as Record<string, unknown>
    if (p.type === 'message' && p.stop_reason) {
      return `stop_reason=${p.stop_reason}`
    }
  }
  return JSON.stringify(payload).slice(0, 200)
}

export function pickModelsByEndpoint(models: Array<Model>, endpoint: string): Array<Model> {
  return models.filter(m => m.supported_endpoints?.includes(endpoint))
}

export function pickFirstModelByEndpoint(models: Array<Model>, endpoint: string): Model | undefined {
  return models.find(m => m.supported_endpoints?.includes(endpoint))
}

export function pickModelById(models: Array<Model>, id: string): Model | undefined {
  return models.find(m => m.id === id)
}

export function pickMessagesModels(models: Array<Model>): Array<Model> {
  return pickModelsByEndpoint(models, MESSAGES_ENDPOINT)
}

export function pickFirstMessagesModel(models: Array<Model>): Model | undefined {
  return pickFirstModelByEndpoint(models, MESSAGES_ENDPOINT)
}

export function pickResponsesModels(models: Array<Model>): Array<Model> {
  return pickModelsByEndpoint(models, RESPONSES_ENDPOINT)
}

export function pickFirstResponsesModel(models: Array<Model>): Model | undefined {
  return pickFirstModelByEndpoint(models, RESPONSES_ENDPOINT)
}

export function pickFirstReasoningMessagesModel(models: Array<Model>): Model | undefined {
  return models.find(model =>
    model.supported_endpoints?.includes(MESSAGES_ENDPOINT)
    && (model.capabilities.supports.reasoning_effort?.length ?? 0) > 0,
  ) ?? pickFirstMessagesModel(models)
}

/**
 * Wrap an async main function with process.exit handling.
 */
export function runMain(main: () => Promise<void>): void {
  void main()
    .then(() => process.exit(0))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exit(1)
    })
}

export function tryParseJson(text: string): unknown {
  if (!text.trim())
    return null
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

export interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/**
 * Extract the Anthropic `usage` block from a parsed /v1/messages response.
 */
export function parseAnthropicUsage(parsed: unknown): AnthropicUsage | undefined {
  if (typeof parsed === 'object' && parsed !== null) {
    return (parsed as { usage?: AnthropicUsage }).usage
  }
  return undefined
}

/**
 * Classify prompt-cache status from a usage block: 'hit' when cached tokens
 * were read, 'miss' when usage is present but no cache read, 'unknown' when
 * usage is absent.
 */
export function classifyCacheStatus(usage: AnthropicUsage | undefined): 'hit' | 'miss' | 'unknown' {
  if ((usage?.cache_read_input_tokens ?? 0) > 0)
    return 'hit'
  if (usage)
    return 'miss'
  return 'unknown'
}
