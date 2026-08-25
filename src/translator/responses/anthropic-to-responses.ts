import type {
  AnthropicAssistantMessage,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicSystemMessage,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicUserMessage,
} from '~/translator'
import type {
  ResponseInputContent,
  ResponseInputItem,
  ResponsesPayload,
  ResponseTool,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from '~/types'
import { clampEffortToAdvertised } from '~/transform'
import { isAnthropicBuiltinTool } from '~/translator'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { normalizeFunctionParametersSchemaForCopilot } from './function-schema'

import {
  createCompactionContent,
  createFunctionCallOutput,
  createFunctionToolCall,
  createMessage,
  createReasoningContent,
  createRedactedReasoningContent,
  createServerFunctionCallOutput,
  createTextContent,
  flushPendingContent,
  isServerToolResultBlock,
  resolveAssistantPhase,
  translateAssistantContentBlock,
  translateUserContentBlock,
} from './response-items'
import { SignatureCodec } from './signature-codec'

const USER_ID_ACCOUNT_RE = /user_([^_]+)_account/
const USER_ID_SESSION_RE = /_session_(.+)$/

export interface AnthropicToResponsesOptions {
  reasoningEffortResolver?: (model: string) => string
  /**
   * The target model's advertised `reasoning_effort` levels.
   *
   * Probed 2026-07-26 (`scripts/probes/effort-and-tokens.ts`): a model rejects
   * every level it does not advertise, so this list is authoritative for
   * clamping. It is not an ordered ladder — `claude-opus-4.6` and
   * `claude-sonnet-4.6` advertise `max` but not `xhigh` — so the clamp target
   * is derived from the list rather than a fixed fallback.
   *
   * Omit it and the effort passes through untouched: with nothing to derive
   * from, forwarding the caller's request is better than guessing at a level
   * that may be both a downgrade and still unsupported.
   */
  supportedEfforts?: Array<string>
}

export function translateAnthropicToResponsesPayload(
  payload: AnthropicMessagesPayload,
  options?: AnthropicToResponsesOptions,
): ResponsesPayload {
  assertResponsesCompatibleRequest(payload)

  const input: Array<ResponseInputItem> = []

  for (const message of payload.messages) {
    input.push(...translateMessage(message))
  }

  const { safetyIdentifier, promptCacheKey } = parseUserId(payload.metadata?.user_id)
  const reasoning = resolveResponsesReasoningConfig(payload, options)
  const text = resolveResponsesTextConfig(payload)

  return {
    model: payload.model,
    input,
    instructions: translateSystemPrompt(payload.system),
    temperature: payload.temperature ?? null,
    top_p: payload.top_p ?? null,
    ...(payload.top_k !== undefined ? { top_k: payload.top_k } : {}),
    max_output_tokens: payload.max_tokens,
    tools: convertAnthropicTools(payload.tools),
    tool_choice: convertAnthropicToolChoice(payload.tool_choice),
    metadata: payload.metadata ? { ...payload.metadata } : null,
    safety_identifier: safetyIdentifier,
    prompt_cache_key: promptCacheKey,
    stream: payload.stream ?? null,
    store: false,
    parallel_tool_calls: true,
    ...(text ? { text } : {}),
    ...(reasoning
      ? {
          reasoning,
          include: ['reasoning.encrypted_content'],
        }
      : {}),
  }
}

function translateMessage(message: AnthropicMessage): Array<ResponseInputItem> {
  switch (message.role) {
    case 'user':
      return translateUserMessage(message)
    case 'assistant':
      return translateAssistantMessage(message)
    case 'system':
      return translateSystemMessage(message)
  }
}

function translateSystemMessage(
  message: AnthropicSystemMessage,
): Array<ResponseInputItem> {
  if (typeof message.content === 'string') {
    return [createMessage('system', message.content)]
  }
  if (!Array.isArray(message.content)) {
    return []
  }

  return [createMessage('system', message.content.map(block => createTextContent(block.text)))]
}

function translateUserMessage(
  message: AnthropicUserMessage,
): Array<ResponseInputItem> {
  if (typeof message.content === 'string') {
    return [createMessage('user', message.content)]
  }
  if (!Array.isArray(message.content)) {
    return []
  }

  const items: Array<ResponseInputItem> = []
  const pendingContent: Array<ResponseInputContent> = []

  for (const block of message.content) {
    if (block.type === 'tool_result' || block.type === 'mcp_tool_result') {
      flushPendingContent(pendingContent, items, { role: 'user' })
      items.push(createFunctionCallOutput(block))
      continue
    }

    if (isServerToolResultBlock(block)) {
      flushPendingContent(pendingContent, items, { role: 'user' })
      items.push(createServerFunctionCallOutput(block))
      continue
    }

    const converted = translateUserContentBlock(block)
    if (converted) {
      pendingContent.push(converted)
    }
  }

  flushPendingContent(pendingContent, items, { role: 'user' })
  return items
}

function translateAssistantMessage(
  message: AnthropicAssistantMessage,
): Array<ResponseInputItem> {
  const assistantPhase = resolveAssistantPhase(message.content)
  if (typeof message.content === 'string') {
    return [createMessage('assistant', message.content, assistantPhase)]
  }
  if (!Array.isArray(message.content)) {
    return []
  }

  const items: Array<ResponseInputItem> = []
  const pendingContent: Array<ResponseInputContent> = []

  for (const block of message.content) {
    if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
      flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
      items.push(createFunctionToolCall(block))
      continue
    }

    if (block.type === 'redacted_thinking') {
      flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
      items.push(createRedactedReasoningContent(block))
      continue
    }

    if (block.type === 'mcp_tool_result') {
      flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
      items.push(createFunctionCallOutput(block))
      continue
    }

    if (isServerToolResultBlock(block)) {
      flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
      items.push(createServerFunctionCallOutput(block))
      continue
    }

    if (block.type === 'thinking' && block.signature) {
      const compaction = createCompactionContent(block)
      if (compaction) {
        flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
        items.push(compaction)
        continue
      }

      if (SignatureCodec.isReasoningSignature(block.signature)) {
        const { id } = SignatureCodec.decodeReasoning(block.signature)
        if (id) {
          flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
          items.push(createReasoningContent(block))
          continue
        }
      }
    }

    const converted = translateAssistantContentBlock(block)
    if (converted) {
      pendingContent.push(converted)
    }
  }

  flushPendingContent(pendingContent, items, { role: 'assistant', phase: assistantPhase })
  return items
}

function translateSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
): string | null {
  if (!system) {
    return null
  }
  if (typeof system === 'string') {
    return system
  }
  const text = system.map(block => block.text).join(' ')
  return text.length > 0 ? text : null
}

function convertAnthropicTools(
  tools: Array<AnthropicTool> | undefined,
): Array<ResponseTool> | null {
  if (!tools || tools.length === 0) {
    return null
  }
  // No `strict` key. Anthropic's tool schema has no `strict` concept, so there
  // is nothing to forward, and omitting it is measurably safer than sending
  // `false`: probed 2026-08-06 (`scripts/probes/tool-strict.ts`), a schema
  // whose `required` names an undeclared key returns 200 with the key absent
  // and 400 with `strict: false`.
  return tools.map((tool) => {
    if (isAnthropicBuiltinTool(tool)) {
      throw new TranslationFailure(
        `Anthropic built-in/toolset "${tool.type ?? tool.name ?? 'unknown'}" cannot be translated to the Responses API.`,
        {
          status: 400,
          kind: 'unsupported_server_tool',
        },
      )
    }

    if (tool.name === undefined || tool.input_schema === undefined) {
      throw new TranslationFailure(
        'Anthropic function tools require both name and input_schema.',
        {
          status: 400,
          kind: 'invalid_tool_schema',
        },
      )
    }

    return {
      type: 'function' as const,
      name: tool.name,
      parameters: normalizeFunctionParametersSchemaForCopilot(tool.input_schema),
      ...(tool.description ? { description: tool.description } : {}),
    }
  })
}

function convertAnthropicToolChoice(
  choice: AnthropicMessagesPayload['tool_choice'],
): ToolChoiceOptions | ToolChoiceFunction {
  if (!choice) {
    return 'auto'
  }
  switch (choice.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'tool':
      return choice.name ? { type: 'function', name: choice.name } : 'auto'
    case 'none':
      return 'none'
  }
}

function resolveResponsesReasoningConfig(
  payload: AnthropicMessagesPayload,
  options?: AnthropicToResponsesOptions,
): ResponsesPayload['reasoning'] | undefined {
  const effort = resolveResponsesReasoningEffort(payload, options)
  if (!effort) {
    return undefined
  }

  return {
    effort,
    summary: effort === 'none' ? null : 'detailed',
  }
}

function resolveResponsesTextConfig(
  payload: AnthropicMessagesPayload,
): ResponsesPayload['text'] | undefined {
  const format = payload.output_config?.format
  if (!format) {
    return undefined
  }

  switch (format.type) {
    case 'json_schema':
      return {
        format: {
          type: 'json_schema',
          name: format.name ?? 'anthropic_output',
          schema: format.schema,
          ...(format.description !== undefined ? { description: format.description } : {}),
          ...(format.strict !== undefined ? { strict: format.strict } : {}),
        },
      }
  }
}
/**
 * Resolve the Responses `reasoning.effort` for an Anthropic request.
 *
 * Every branch below produces a *candidate* the caller did not name directly —
 * a hardcoded tier, a config default, or a mapped `output_config.effort` — so
 * all of them are clamped at the single exit. Clamping only the
 * `output_config.effort` branch left the others able to emit a level the model
 * rejects: `adaptive` sent `medium` to a model advertising `[high, xhigh, max]`,
 * and `enabled` sent the configured default with an `as` cast and no check.
 */
function resolveResponsesReasoningEffort(
  payload: AnthropicMessagesPayload,
  options?: AnthropicToResponsesOptions,
): NonNullable<ResponsesPayload['reasoning']>['effort'] | undefined {
  const candidate = resolveEffortCandidate(payload, options)
  if (!candidate) {
    return candidate
  }
  return clampResponsesEffort(candidate, options)
}

function resolveEffortCandidate(
  payload: AnthropicMessagesPayload,
  options?: AnthropicToResponsesOptions,
): NonNullable<ResponsesPayload['reasoning']>['effort'] | undefined {
  if (payload.thinking?.type === 'disabled') {
    return 'none'
  }

  if (payload.output_config?.effort) {
    return payload.output_config.effort
  }

  if (payload.thinking?.type === 'adaptive') {
    return 'medium'
  }

  if (payload.thinking?.type === 'enabled') {
    return (options?.reasoningEffortResolver?.(payload.model) ?? 'medium') as NonNullable<ResponsesPayload['reasoning']>['effort']
  }

  return undefined
}

/**
 * Clamp a Responses effort to what the target model advertises.
 *
 * `none` and `minimal` belong to the Responses vocabulary but not to the
 * Anthropic `output_config` ladder, so they are passed through rather than
 * ranked: `none` means "do not reason", and clamping it *up* to the model's
 * highest advertised level would invert the caller's intent. Every model
 * observed on `/responses` advertises `none` (probed 2026-07-26).
 *
 * With no advertised list the effort passes through untouched — with nothing to
 * derive from, forwarding the request beats guessing at a level that may be both
 * a downgrade and still unsupported.
 */
function clampResponsesEffort(
  effort: NonNullable<NonNullable<ResponsesPayload['reasoning']>['effort']>,
  options?: AnthropicToResponsesOptions,
): NonNullable<ResponsesPayload['reasoning']>['effort'] {
  if (effort === 'none' || effort === 'minimal') {
    return effort
  }
  return clampEffortToAdvertised(effort, options?.supportedEfforts) ?? effort
}

function assertResponsesCompatibleRequest(
  payload: AnthropicMessagesPayload,
) {
  if (payload.stop_sequences?.length) {
    throw new TranslationFailure(
      'Anthropic stop_sequences cannot be forwarded through the Responses execution path.',
      {
        status: 400,
        kind: 'unsupported_stop_sequences',
      },
    )
  }

  if (payload.service_tier !== undefined) {
    throw new TranslationFailure(
      'Anthropic service_tier is not supported on the Responses execution path.',
      {
        status: 400,
        kind: 'unsupported_service_tier',
      },
    )
  }
}

function parseUserId(
  userId: string | undefined,
): { safetyIdentifier: string | null, promptCacheKey: string | null } {
  if (!userId) {
    return { safetyIdentifier: null, promptCacheKey: null }
  }

  const userMatch = userId.match(USER_ID_ACCOUNT_RE)
  const sessionMatch = userId.match(USER_ID_SESSION_RE)

  return {
    safetyIdentifier: userMatch ? userMatch[1] : null,
    promptCacheKey: sessionMatch ? sessionMatch[1] : null,
  }
}
