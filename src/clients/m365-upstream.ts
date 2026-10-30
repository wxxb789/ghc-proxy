/**
 * Microsoft 365 Copilot coding-agent gateway: transport constants, the
 * Anthropic-shaped header contract, and the static model catalog.
 *
 * The gateway exposes no `/models` endpoint (`404 NonExistentApi`), so the
 * catalog is authored here. Only names verified against the live gateway are
 * listed; the gateway rejects other names with `403 model_not_allowed`.
 */
import type { ModelsResponse } from '~/types'

import { randomUUID } from 'node:crypto'

export const M365_BASE_URL = 'https://msit.loki.delve.office.com/api/v1/llmapi'
export const M365_ANTHROPIC_VERSION = '2023-06-01'
export const M365_API_VERSION = '2026-10-16'

const CONTEXT_WINDOW_TOKENS = 200_000
const MAX_OUTPUT_TOKENS = 32_000

const VERIFIED_MODELS: Array<{ id: string, name: string }> = [
  { id: 'claude-opus-5.5', name: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5.5', name: 'Claude Haiku 5.5' },
]

export const M365_MODELS: ModelsResponse = {
  object: 'list',
  data: VERIFIED_MODELS.map(model => ({
    id: model.id,
    name: model.name,
    object: 'model',
    vendor: 'anthropic',
    version: '5.5',
    preview: false,
    model_picker_enabled: true,
    supported_endpoints: ['/v1/messages'],
    capabilities: {
      family: model.id,
      object: 'model_capabilities',
      type: 'chat',
      tokenizer: 'cl100k_base',
      limits: {
        max_context_window_tokens: CONTEXT_WINDOW_TOKENS,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        max_prompt_tokens: CONTEXT_WINDOW_TOKENS,
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
