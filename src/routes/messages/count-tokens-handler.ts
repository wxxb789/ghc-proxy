import type { Context } from 'hono'

import consola from 'consola'

import { AnthropicMessagesAdapter } from '~/adapters'
import { HTTPError } from '~/lib/error'
import { getModelFallbackConfig, resolveModel } from '~/lib/model-resolver'
import { state } from '~/lib/state'
import { getTokenCount } from '~/lib/tokenizer'
import { parseAnthropicCountTokensPayload } from '~/lib/validation'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'

// Token estimation constants
const CLAUDE_TOOL_OVERHEAD_TOKENS = 346
const GROK_TOOL_OVERHEAD_TOKENS = 480
const CLAUDE_ESTIMATION_FACTOR = 1.15
const GROK_ESTIMATION_FACTOR = 1.03

export interface CountTokensCoreParams {
  body: unknown
  headers: Headers
}

/**
 * Framework-agnostic handler for counting tokens.
 */
export async function handleCountTokensCore(
  { body, headers }: CountTokensCoreParams,
): Promise<{ input_tokens: number }> {
  const anthropicBeta = headers.get('anthropic-beta') ?? undefined
  const anthropicPayload = parseAnthropicCountTokensPayload(body)

  const knownModelIds = state.cache.models
    ? new Set(state.cache.models.data.map(model => model.id))
    : undefined
  const fallbackConfig = getModelFallbackConfig()
  const adapter = new AnthropicMessagesAdapter({
    modelResolver: (model: string) => resolveModel(model, knownModelIds, fallbackConfig),
    getModelCapabilities: (model: string) => ({
      supportsThinkingBudget: model.startsWith('claude'),
    }),
  })

  let openAIPayload
  try {
    openAIPayload = adapter.toTokenCountPayload(anthropicPayload)
  }
  catch (error) {
    if (error instanceof TranslationFailure) {
      throw new HTTPError(
        error.message,
        new Response(error.message, { status: error.status }),
      )
    }
    throw error
  }

  const selectedModel = state.cache.models?.data.find(
    model => model.id === openAIPayload.model,
  )

  if (!selectedModel) {
    throw new HTTPError(
      `Model not found for token counting: "${openAIPayload.model}"`,
      new Response(
        `Model not found for token counting: "${openAIPayload.model}"`,
        {
          status: 400,
        },
      ),
    )
  }

  const tokenCount = await getTokenCount(openAIPayload, selectedModel)

  if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
    let mcpToolExist = false
    if (anthropicBeta?.startsWith('claude-code')) {
      mcpToolExist = anthropicPayload.tools.some(tool =>
        tool.name.startsWith('mcp__'),
      )
    }
    if (!mcpToolExist) {
      if (anthropicPayload.model.startsWith('claude')) {
        // https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview#pricing
        tokenCount.input = tokenCount.input + CLAUDE_TOOL_OVERHEAD_TOKENS
      }
      else if (anthropicPayload.model.startsWith('grok')) {
        tokenCount.input = tokenCount.input + GROK_TOOL_OVERHEAD_TOKENS
      }
    }
  }

  let finalTokenCount = tokenCount.input + tokenCount.output
  if (anthropicPayload.model.startsWith('claude')) {
    finalTokenCount = Math.round(finalTokenCount * CLAUDE_ESTIMATION_FACTOR)
  }
  else if (anthropicPayload.model.startsWith('grok')) {
    finalTokenCount = Math.round(finalTokenCount * GROK_ESTIMATION_FACTOR)
  }

  consola.info('Token count:', finalTokenCount)

  return {
    input_tokens: finalTokenCount,
  }
}

/**
 * Hono-specific handler wrapper.
 */
export async function handleCountTokens(c: Context) {
  const result = await handleCountTokensCore({
    body: await c.req.json(),
    headers: c.req.raw.headers,
  })
  return c.json(result)
}
