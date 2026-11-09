/**
 * Microsoft 365 Copilot coding-agent gateway: transport constants, the
 * gateway header contract, and the model catalog.
 *
 * Names the gateway does not list are rejected with `403 model_not_allowed`;
 * `max_tokens` above the value below is rejected with `400 invalid_body`.
 */
import type { ModelFallbackConfig } from '~/lib/model-resolver'
import type { Model, ModelsResponse } from '~/types'

import { randomUUID } from 'node:crypto'

import { HTTPError } from '~/lib/error'
import { M365_DEFAULT_ENDPOINT } from '~/lib/m365-endpoints'
import { MESSAGES_ENDPOINT, RESPONSES_ENDPOINT } from '~/state/model-cache'

export const M365_ANTHROPIC_VERSION = '2023-06-01'
export const M365_API_VERSION = '2026-10-16'

/**
 * Measured on 2026-10-31: `max_tokens: 128000` returns 200, `128001` returns
 * 400, for every `/v1/messages` catalog model. The gateway reports only
 * `invalid_body`, so the exact ceiling is pinned by bisection rather than read
 * from an error message. `/responses` models were not measured and advertise
 * no output ceiling.
 */
const MAX_OUTPUT_TOKENS = 128_000

/**
 * Context window for the 5.5 series.
 *
 * Measured: a 546,008 input-token request succeeds and the
 * `context-1m-2025-08-07` beta is accepted, so the real ceiling is >= 546k but
 * has not been pinned. 1M is an operator assumption for the 5.5 series, not a
 * measurement; models without it advertise no context limit, and consumers
 * treat a missing limit as "do not clamp".
 */
const ASSUMED_CONTEXT_TOKENS = 1_000_000
const VERIFIED_MODELS: Array<{
  id: string
  name: string
  contextTokens?: number
}> = [
  { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', contextTokens: ASSUMED_CONTEXT_TOKENS },
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', contextTokens: ASSUMED_CONTEXT_TOKENS },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'claude-haiku-5.5', name: 'Claude Haiku 5.5', contextTokens: ASSUMED_CONTEXT_TOKENS },
]

/**
 * Family fallbacks for unadvertised model ids. Every target is a catalog member,
 * so a rewrite never lands on a name the gateway rejects (`claude-haiku-4.5`, the
 * GitHub default, is a 403 here).
 */
export const M365_FALLBACKS: ModelFallbackConfig = {
  claudeOpus: 'claude-opus-5.5',
  claudeSonnet: 'claude-sonnet-5.5',
  claudeHaiku: 'claude-haiku-5.5',
}

interface GatewayModel {
  id?: unknown
  name?: unknown
  publisher?: unknown
  supported_endpoints?: unknown
  capabilities?: {
    limits?: { max_context_window_tokens?: unknown }
    supports?: { reasoning_effort?: unknown }
  }
}

/**
 * Endpoints the M365 target serves. Anything else the gateway advertises is
 * dropped, so a model is never routed to an endpoint the target refuses.
 */
const SERVED_ENDPOINTS: ReadonlyArray<string> = [MESSAGES_ENDPOINT, RESPONSES_ENDPOINT]

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function toCatalogModel(entry: GatewayModel): Model | undefined {
  const id = typeof entry.id === 'string' ? entry.id : ''
  const endpoints = stringsOf(entry.supported_endpoints)
    .filter(endpoint => SERVED_ENDPOINTS.includes(endpoint))
  if (!id || endpoints.length === 0) {
    return undefined
  }
  const contextTokens = entry.capabilities?.limits?.max_context_window_tokens
  const reasoningEfforts = stringsOf(entry.capabilities?.supports?.reasoning_effort)
  const name = typeof entry.name === 'string' ? entry.name : id
  const publisher = typeof entry.publisher === 'string' ? entry.publisher.toLowerCase() : 'anthropic'
  return {
    id,
    name,
    object: 'model',
    vendor: publisher,
    version: id.split('-').at(-1) ?? '',
    preview: false,
    model_picker_enabled: true,
    supported_endpoints: endpoints,
    capabilities: {
      family: id,
      object: 'model_capabilities',
      type: 'chat',
      tokenizer: 'cl100k_base',
      limits: {
        ...(endpoints.includes(MESSAGES_ENDPOINT) ? { max_output_tokens: MAX_OUTPUT_TOKENS } : {}),
        ...(typeof contextTokens === 'number'
          ? { max_context_window_tokens: contextTokens, max_prompt_tokens: contextTokens }
          : {}),
      },
      supports: {
        tool_calls: true,
        parallel_tool_calls: true,
        streaming: true,
        ...(reasoningEfforts.length > 0 ? { reasoning_effort: reasoningEfforts } : {}),
      },
    },
  }
}

const CATALOG_TIMEOUT_MS = 10_000

/**
 * Normalizes a gateway catalog payload into the model list the proxy serves:
 * Anthropic models on `/v1/messages` and OpenAI models on `/responses`.
 * Entries with neither endpoint are dropped.
 */
export function normalizeM365Catalog(payload: unknown): ModelsResponse {
  const data = (payload as { data?: unknown } | null | undefined)?.data
  const entries = Array.isArray(data) ? data as GatewayModel[] : []
  const models = entries
    .map(toCatalogModel)
    .filter((model): model is Model => model !== undefined)
  if (models.length === 0) {
    throw new Error('M365 model catalog returned no /v1/messages or /responses models')
  }
  return { object: 'list', data: models }
}

/**
 * Reads the gateway catalog (`GET /api/v1/llmapi/models`). The endpoint exists,
 * returns every model regardless of query parameters, and reports the real
 * context window, so the static list is only a fallback.
 */
export async function fetchM365Models(
  token: string,
  endpoint: string = M365_DEFAULT_ENDPOINT,
  fetchImpl: (input: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<ModelsResponse> {
  const response = await fetchImpl(`${endpoint}/models`, {
    method: 'GET',
    headers: m365Headers(token),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new HTTPError(response.status, {
      error: {
        message: `M365 model catalog request failed with ${response.status}${response.status === 401 || response.status === 403 ? '; select a work account with gateway access and a Copilot subscription' : ''}`,
        type: 'upstream_error',
      },
    })
  }
  return normalizeM365Catalog(await response.json())
}

const FALLBACK_BY_FAMILY: Array<{ prefix: string, key: keyof ModelFallbackConfig }> = [
  { prefix: 'claude-opus-', key: 'claudeOpus' },
  { prefix: 'claude-sonnet-', key: 'claudeSonnet' },
  { prefix: 'claude-haiku-', key: 'claudeHaiku' },
]

/**
 * Maps an unadvertised `claude-<family>-*` id to the catalog target for that
 * family. Returns `undefined` for advertised ids and for other vendors, so the
 * caller can leave the request untouched.
 */
export function m365FallbackFor(modelId: string, knownModelIds: ReadonlyArray<string>): string | undefined {
  if (knownModelIds.includes(modelId)) {
    return undefined
  }
  const family = FALLBACK_BY_FAMILY.find(entry => modelId.startsWith(entry.prefix))
  return family ? M365_FALLBACKS[family.key] : undefined
}

export const M365_MODELS: ModelsResponse = {
  object: 'list',
  data: VERIFIED_MODELS
    .map(model => toCatalogModel({
      id: model.id,
      name: model.name,
      publisher: 'anthropic',
      supported_endpoints: ['/v1/messages'],
      capabilities: model.contextTokens === undefined
        ? undefined
        : { limits: { max_context_window_tokens: model.contextTokens } },
    }))
    .filter((model): model is Model => model !== undefined),
}

/**
 * The gateway is an unattended proxy upstream, so the headers mirror what the
 * Copilot host sends for a user-initiated turn. `X-Initiator` stays `user`:
 * that is the combination verified against the live gateway.
 */
export function m365Headers(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'content-type': 'application/json',
    'anthropic-version': M365_ANTHROPIC_VERSION,
    'X-ClientType': 'Copilot',
    'X-ClientFeature': 'LlmApiProxy',
    'X-ClientScenario': 'Code',
    'X-HostPlatform': 'Windows',
    'X-Llm-Api-Version': M365_API_VERSION,
    'X-ConversationId': randomUUID(),
    'X-ClientCallId': randomUUID(),
    'X-Initiator': 'user',
  }
}
