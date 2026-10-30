/**
 * Microsoft 365 Copilot coding-agent gateway: transport constants, the
 * Anthropic-shaped header contract, and the static model catalog.
 *
 * The gateway exposes no `/models` endpoint (`404 NonExistentApi`), so the
 * catalog is authored here from live probes. Names not listed are rejected with
 * `403 model_not_allowed`; `max_tokens` above the value below is rejected with
 * `400 invalid_body`.
 */
import type { ModelFallbackConfig } from '~/lib/model-resolver'
import type { ModelsResponse } from '~/types'

import { randomUUID } from 'node:crypto'

export const M365_BASE_URL = 'https://msit.loki.delve.office.com/api/v1/llmapi'
export const M365_ANTHROPIC_VERSION = '2023-06-01'
export const M365_API_VERSION = '2026-10-16'

/**
 * Measured on 2026-10-31: `max_tokens: 128000` returns 200, `128001` returns
 * 400, for every catalog model. The gateway reports only `invalid_body`, so the
 * exact ceiling is pinned by bisection rather than read from an error message.
 */
const MAX_OUTPUT_TOKENS = 128_000

/**
 * Context window is a measured lower bound, not a configured value: a 546,008
 * input-token request succeeds, and the `context-1m-2025-08-07` beta is
 * accepted. The real ceiling is therefore unknown (>= 546k), so the catalog
 * advertises no `max_context_window_tokens`/`max_prompt_tokens` rather than
 * inventing one; consumers treat a missing limit as "do not clamp".
 */
const VERIFIED_MODELS: Array<{ id: string, name: string, version: string }> = [
  { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', version: '5.5' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', version: '5' },
  { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', version: '5.5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', version: '5' },
  { id: 'claude-haiku-5.5', name: 'Claude Haiku 5.5', version: '5.5' },
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
  data: VERIFIED_MODELS.map(model => ({
    id: model.id,
    name: model.name,
    object: 'model',
    vendor: 'anthropic',
    version: model.version,
    preview: false,
    model_picker_enabled: true,
    supported_endpoints: ['/v1/messages'],
    capabilities: {
      family: model.id,
      object: 'model_capabilities',
      type: 'chat',
      tokenizer: 'cl100k_base',
      limits: {
        max_output_tokens: MAX_OUTPUT_TOKENS,
      },
      supports: {
        tool_calls: true,
        parallel_tool_calls: true,
        streaming: true,
      },
    },
  })),
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
