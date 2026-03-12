import consola from 'consola'

import { fromTranslationFailure, HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import { getTokenCount } from '~/lib/tokenizer'
import { parseAnthropicCountTokensPayload } from '~/lib/validation'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'

import { createAnthropicAdapter } from './shared'

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
 * Core handler for counting tokens.
 */
export async function handleCountTokensCore(
  { body, headers }: CountTokensCoreParams,
): Promise<{ input_tokens: number }> {
  const anthropicBeta = headers.get('anthropic-beta') ?? undefined
  const anthropicPayload = parseAnthropicCountTokensPayload(body)

  const adapter = createAnthropicAdapter()

  let openAIPayload
  try {
    openAIPayload = adapter.toTokenCountPayload(anthropicPayload)
  }
  catch (error) {
    if (error instanceof TranslationFailure) {
      throw fromTranslationFailure(error)
    }
    throw error
  }

  const selectedModel = state.cache.models?.data.find(
    model => model.id === openAIPayload.model,
  )

  if (!selectedModel) {
    throw new HTTPError(400, {
      error: {
        message: `Model not found for token counting: "${openAIPayload.model}"`,
        type: 'invalid_request_error',
      },
    })
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
