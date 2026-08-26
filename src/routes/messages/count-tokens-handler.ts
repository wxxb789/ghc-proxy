import type { AnthropicCountTokensPayload } from '~/translator'
import consola from 'consola'

import { inferModelFamily } from '~/core/capi/profile'
import { protocolRegistry } from '~/ingest'
import { resolveModelOrThrow, withTranslationErrors } from '~/lib/error'
import { estimateSerializedTokens, getTokenCount } from '~/lib/tokenizer'
import { isAnthropicBuiltinTool } from '~/translator'

import { createAnthropicAdapter } from './shared'

// Per-family token estimation calibration
const TOOL_OVERHEAD_TOKENS: Record<string, number> = {
  claude: 346, // https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview#pricing
  grok: 480,
  gpt: 346,
}

const ESTIMATION_FACTOR: Record<string, number> = {
  claude: 1.15,
  grok: 1.03,
  gpt: 1.10,
}

// Conservative maximums from Anthropic's documented August 2026 toolset
// costs. Browser includes the Sonnet 5 default plus all optional members.
const BUILTIN_TOOLSET_TOKENS: Record<string, number> = {
  browser_toolset_20260801: 7_550,
  computer_toolset_20260801: 4_590,
}

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
  const { payload: anthropicPayload } = protocolRegistry.ingest<AnthropicCountTokensPayload>(
    'anthropic-count-tokens',
    body,
    headers,
  )

  const functionTools = []
  const uncalibratedBuiltinTools = []
  let calibratedBuiltinTokens = 0
  let hasBuiltinTools = false

  for (const tool of anthropicPayload.tools ?? []) {
    if (!isAnthropicBuiltinTool(tool)) {
      functionTools.push(tool)
      continue
    }

    hasBuiltinTools = true
    const builtinTokens = tool.type ? BUILTIN_TOOLSET_TOKENS[tool.type] : undefined
    if (builtinTokens === undefined)
      uncalibratedBuiltinTools.push(tool)
    else
      calibratedBuiltinTokens += builtinTokens
  }

  const countPayload = hasBuiltinTools
    ? { ...anthropicPayload, tools: functionTools }
    : anthropicPayload

  const adapter = createAnthropicAdapter()
  const openAIPayload = withTranslationErrors(() => adapter.toTokenCountPayload(countPayload))
  const selectedModel = resolveModelOrThrow(openAIPayload.model)

  const tokenCount = await getTokenCount(openAIPayload, selectedModel)
  if (uncalibratedBuiltinTools.length > 0)
    tokenCount.input += await estimateSerializedTokens(uncalibratedBuiltinTools, selectedModel)

  if (functionTools.length > 0) {
    let mcpToolExist = false
    if (anthropicBeta?.startsWith('claude-code')) {
      mcpToolExist = functionTools.some(tool =>
        tool.name?.startsWith('mcp__') ?? false,
      )
    }
    if (!mcpToolExist) {
      const overhead = TOOL_OVERHEAD_TOKENS[inferModelFamily(anthropicPayload.model)]
      if (overhead) {
        tokenCount.input = tokenCount.input + overhead
      }
    }
  }

  let finalTokenCount = tokenCount.input + tokenCount.output
  const factor = ESTIMATION_FACTOR[inferModelFamily(anthropicPayload.model)]
  if (factor) {
    finalTokenCount = Math.round(finalTokenCount * factor)
  }
  finalTokenCount += calibratedBuiltinTokens

  consola.info('Token count:', finalTokenCount)

  return {
    input_tokens: finalTokenCount,
  }
}
