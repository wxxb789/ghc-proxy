/**
 * Shared utilities for probe scripts that send raw requests
 * to Copilot's upstream endpoints.
 */

import type { Model } from '~/types'

import process from 'node:process'
import consola from 'consola'
import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { getCachedConfig, readConfig } from '~/lib/config'
import { MESSAGES_ENDPOINT } from '~/lib/model-capabilities'
import { ensurePaths } from '~/lib/paths'
import { cacheModels, cacheVSCodeVersion, getClientConfig } from '~/lib/state'
import { setupCopilotToken, setupGitHubToken } from '~/lib/token'
import { authStore } from '~/state'

export const REQUEST_TIMEOUT_MS = 30_000

export interface ProbeResult {
  name: string
  extraFields: Record<string, unknown>
  status: 'accepted' | 'rejected' | 'error'
  httpStatus?: number
  errorMessage?: string
  note: string
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
    const clientConfig = getClientConfig()
    const url = `${copilotBaseUrl(clientConfig)}${MESSAGES_ENDPOINT}`
    const headers = copilotHeaders(authStore, clientConfig, { initiator: 'agent' })

    // Honor the timeout chosen at bootstrap (stored as upstreamTimeoutSeconds);
    // a probe bootstrapped at 120s must not abort client-side at the 30s default.
    const timeoutMs = (authStore.upstreamTimeoutSeconds || 0) * 1000 || REQUEST_TIMEOUT_MS

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })

    const text = await response.text()
    const parsed = tryParseJson(text)

    if (response.status >= 200 && response.status < 300) {
      return {
        name: '',
        extraFields,
        status: 'accepted',
        httpStatus: response.status,
        note: summarizeResponse(parsed),
      }
    }

    const errorMsg = extractErrorMessage(parsed)
    return {
      name: '',
      extraFields,
      status: 'rejected',
      httpStatus: response.status,
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

export function summarizeResponse(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as Record<string, unknown>
    if (p.type === 'message' && p.stop_reason) {
      return `stop_reason=${p.stop_reason}`
    }
  }
  return JSON.stringify(payload).slice(0, 200)
}

export function pickMessagesModels(models: Array<Model>): Array<Model> {
  return models.filter(m => m.supported_endpoints?.includes(MESSAGES_ENDPOINT))
}

export function pickFirstMessagesModel(models: Array<Model>): Model | undefined {
  return models.find(m => m.supported_endpoints?.includes(MESSAGES_ENDPOINT))
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
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}
