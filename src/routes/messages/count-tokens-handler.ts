import type { Context } from 'hono'

import consola from 'consola'

import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import { getTokenCount } from '~/lib/tokenizer'
import { parseAnthropicCountTokensPayload } from '~/lib/validation'
import { AnthropicTranslator } from '~/translator'

// Token estimation constants
const CLAUDE_TOOL_OVERHEAD_TOKENS = 346
const GROK_TOOL_OVERHEAD_TOKENS = 480
const CLAUDE_ESTIMATION_FACTOR = 1.15
const GROK_ESTIMATION_FACTOR = 1.03

/**
 * Handles token counting for Anthropic messages
 */
export async function handleCountTokens(c: Context) {
  const anthropicBeta = c.req.header('anthropic-beta')
  const anthropicPayload = parseAnthropicCountTokensPayload(await c.req.json())
  const normalizedPayload = {
    ...anthropicPayload,
    max_tokens: anthropicPayload.max_tokens ?? 0,
  }

  const translator = new AnthropicTranslator()
  const openAIPayload = translator.toOpenAI(normalizedPayload)

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

  return c.json({
    input_tokens: finalTokenCount,
  })
}
