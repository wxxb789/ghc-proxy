import type { CapiRequestContext } from './types'

import type {
  AnthropicAssistantContentBlock,
  AnthropicCountTokensPayload,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicUserContentBlock,
} from '~/translator'
import type {
  ChatCompletionsPayload,
  Message,
  ResponseInputContent,
  ResponseInputItem,
  ResponsesInputTokensPayload,
  ResponsesPayload,
} from '~/types'

import { readHeader } from './headers'

const SUBAGENT_MARKER_PREFIX = '__SUBAGENT_MARKER__'
const SYSTEM_REMINDER_OPEN_TAG = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE_TAG = '</system-reminder>'

interface SubagentMarkerPayload {
  session_id?: string
  agent_id?: string
  agent_type?: string
}

export function withSubagentMarker(
  baseContext: Partial<CapiRequestContext>,
  headers: Headers,
  marker?: SubagentMarkerPayload,
): Partial<CapiRequestContext> {
  if (!marker) {
    return baseContext
  }

  const rootSessionId = readHeader(headers, 'x-session-id') ?? baseContext.clientSessionId

  return {
    ...baseContext,
    interactionType:
      baseContext.interactionType && baseContext.interactionType !== 'conversation-user'
        ? baseContext.interactionType
        : 'conversation-subagent',
    agentTaskId: baseContext.agentTaskId ?? marker.agent_id ?? marker.session_id,
    clientSessionId: baseContext.clientSessionId ?? rootSessionId ?? marker.session_id,
  }
}

export function stripSubagentMarkerFromAnthropicPayload(
  payload: AnthropicMessagesPayload | AnthropicCountTokensPayload,
): SubagentMarkerPayload | undefined {
  let marker: SubagentMarkerPayload | undefined

  if (typeof payload.system === 'string') {
    const result = stripSubagentMarkerFromText(payload.system)
    payload.system = result.text || undefined
    marker ??= result.marker
  }
  else if (Array.isArray(payload.system)) {
    const result = stripSubagentMarkerFromTextBlocks(payload.system)
    payload.system = result.blocks
    marker ??= result.marker

    if (payload.system.length === 0) {
      payload.system = undefined
    }
  }

  payload.messages = payload.messages
    .map((message) => {
      const sanitized = sanitizeAnthropicMessage(message)
      marker ??= sanitized.marker
      return sanitized.message
    })
    .filter((message): message is AnthropicMessage => message !== undefined)

  return marker
}

function sanitizeAnthropicMessage(
  message: AnthropicMessage,
): { message?: AnthropicMessage, marker?: SubagentMarkerPayload } {
  if (typeof message.content === 'string') {
    const result = stripSubagentMarkerFromText(message.content)
    return {
      marker: result.marker,
      message: result.text
        ? { ...message, content: result.text }
        : undefined,
    }
  }

  if (message.role === 'user') {
    let marker: SubagentMarkerPayload | undefined
    const content: Array<AnthropicUserContentBlock> = message.content
      .map((block) => {
        if (block.type !== 'text') {
          return block
        }

        const result = stripSubagentMarkerFromText(block.text)
        marker ??= result.marker
        return result.text
          ? { ...block, text: result.text }
          : undefined
      })
      .filter((block): block is AnthropicUserContentBlock => block !== undefined)

    return {
      marker,
      message: content.length > 0
        ? { ...message, content }
        : undefined,
    }
  }

  if (message.role === 'system') {
    const result = stripSubagentMarkerFromTextBlocks(message.content)

    return {
      marker: result.marker,
      message: result.blocks.length > 0
        ? { ...message, content: result.blocks }
        : undefined,
    }
  }

  let marker: SubagentMarkerPayload | undefined
  const content: Array<AnthropicAssistantContentBlock> = message.content
    .map((block) => {
      if (block.type !== 'text') {
        return block
      }

      const result = stripSubagentMarkerFromText(block.text)
      marker ??= result.marker
      return result.text
        ? { ...block, text: result.text }
        : undefined
    })
    .filter((block): block is AnthropicAssistantContentBlock => block !== undefined)

  return {
    marker,
    message: content.length > 0
      ? { ...message, content }
      : undefined,
  }
}

function stripSubagentMarkerFromTextBlocks<T extends AnthropicTextBlock>(
  blocks: Array<T>,
): { blocks: Array<T>, marker?: SubagentMarkerPayload } {
  let marker: SubagentMarkerPayload | undefined
  const strippedBlocks = blocks
    .map((block) => {
      const result = stripSubagentMarkerFromText(block.text)
      marker ??= result.marker
      return result.text
        ? { ...block, text: result.text }
        : undefined
    })
    .filter((block): block is T => block !== undefined)

  return { blocks: strippedBlocks, marker }
}

export function stripSubagentMarkerFromChatPayload(
  payload: ChatCompletionsPayload,
): SubagentMarkerPayload | undefined {
  let marker: SubagentMarkerPayload | undefined

  payload.messages = payload.messages
    .map((message) => {
      const sanitized = sanitizeChatMessage(message)
      marker ??= sanitized.marker
      return sanitized.message
    })
    .filter((message): message is Message => message !== undefined)

  return marker
}

function sanitizeChatMessage(
  message: Message,
): { message?: Message, marker?: SubagentMarkerPayload } {
  if (typeof message.content === 'string') {
    const result = stripSubagentMarkerFromText(message.content)
    return {
      marker: result.marker,
      message: result.text || message.tool_calls?.length
        ? { ...message, content: result.text }
        : undefined,
    }
  }

  if (message.content === null) {
    return { message }
  }

  let marker: SubagentMarkerPayload | undefined
  const content = message.content
    .map((part) => {
      if (part.type !== 'text') {
        return part
      }

      const result = stripSubagentMarkerFromText(part.text)
      marker ??= result.marker
      return result.text
        ? { ...part, text: result.text }
        : undefined
    })
    .filter(part => part !== undefined)

  return {
    marker,
    message: content.length > 0 || message.tool_calls?.length
      ? { ...message, content }
      : undefined,
  }
}

export function stripSubagentMarkerFromResponsesPayload(
  payload: ResponsesPayload | ResponsesInputTokensPayload,
): SubagentMarkerPayload | undefined {
  let marker: SubagentMarkerPayload | undefined

  if (typeof payload.instructions === 'string') {
    const result = stripSubagentMarkerFromText(payload.instructions)
    payload.instructions = result.text || undefined
    marker ??= result.marker
  }

  if (typeof payload.input === 'string') {
    const result = stripSubagentMarkerFromText(payload.input)
    payload.input = result.text || null
    marker ??= result.marker
    return marker
  }

  if (!Array.isArray(payload.input)) {
    return marker
  }

  payload.input = payload.input
    .map((item) => {
      const sanitized = sanitizeResponsesInputItem(item)
      marker ??= sanitized.marker
      return sanitized.item
    })
    .filter((item): item is ResponseInputItem => item !== undefined)

  return marker
}

function sanitizeResponsesInputItem(
  item: ResponseInputItem,
): { item?: ResponseInputItem, marker?: SubagentMarkerPayload } {
  if (!('type' in item) || item.type !== 'message') {
    return { item }
  }

  if (typeof item.content === 'string') {
    const result = stripSubagentMarkerFromText(item.content)
    return {
      marker: result.marker,
      item: result.text
        ? { ...item, content: result.text }
        : undefined,
    }
  }

  if (!Array.isArray(item.content)) {
    return { item }
  }

  let marker: SubagentMarkerPayload | undefined
  const content = item.content
    .map((part) => {
      const sanitized = sanitizeResponsesInputContent(part)
      marker ??= sanitized.marker
      return sanitized.content
    })
    .filter((part): part is ResponseInputContent => part !== undefined)

  return {
    marker,
    item: content.length > 0
      ? { ...item, content }
      : undefined,
  }
}

function sanitizeResponsesInputContent(
  content: ResponseInputContent,
): { content?: ResponseInputContent, marker?: SubagentMarkerPayload } {
  if (!('type' in content)) {
    return { content }
  }
  if (content.type !== 'input_text' && content.type !== 'output_text') {
    return { content }
  }
  if (typeof content.text !== 'string') {
    return { content }
  }

  const result = stripSubagentMarkerFromText(content.text)
  return {
    marker: result.marker,
    content: result.text
      ? { ...content, text: result.text }
      : undefined,
  }
}

function stripSubagentMarkerFromText(
  text: string,
): { text: string, marker?: SubagentMarkerPayload } {
  const markerMatch = findSubagentMarker(text)
  if (!markerMatch) {
    return { text }
  }

  const removalRange = findReminderRange(text, markerMatch.start, markerMatch.end)
  const before = text.slice(0, removalRange.start).trimEnd()
  const after = text.slice(removalRange.end).trimStart()

  return {
    marker: markerMatch.marker,
    text: before && after
      ? `${before}\n${after}`
      : `${before}${after}`,
  }
}

function findSubagentMarker(
  text: string,
): { marker: SubagentMarkerPayload, start: number, end: number } | undefined {
  const markerIndex = text.indexOf(SUBAGENT_MARKER_PREFIX)
  if (markerIndex < 0) {
    return undefined
  }

  const jsonStart = text.indexOf('{', markerIndex + SUBAGENT_MARKER_PREFIX.length)
  if (jsonStart < 0) {
    return undefined
  }

  const jsonEnd = findJsonObjectEnd(text, jsonStart)
  if (jsonEnd < 0) {
    return undefined
  }

  try {
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd)) as SubagentMarkerPayload
    if (!parsed || typeof parsed !== 'object') {
      return undefined
    }

    return {
      marker: parsed,
      start: markerIndex,
      end: jsonEnd,
    }
  }
  catch {
    return undefined
  }
}

function findReminderRange(
  text: string,
  markerStart: number,
  markerEnd: number,
): { start: number, end: number } {
  const reminderStart = text.lastIndexOf(SYSTEM_REMINDER_OPEN_TAG, markerStart)
  const reminderEnd = text.indexOf(SYSTEM_REMINDER_CLOSE_TAG, markerEnd)

  if (reminderStart >= 0 && reminderEnd >= 0) {
    return {
      start: reminderStart,
      end: reminderEnd + SYSTEM_REMINDER_CLOSE_TAG.length,
    }
  }

  return { start: markerStart, end: markerEnd }
}

function findJsonObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index++) {
    const char = text[index]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (char === '"') {
      inString = !inString
      continue
    }

    if (inString) {
      continue
    }

    if (char === '{') {
      depth++
      continue
    }

    if (char === '}') {
      depth--
      if (depth === 0) {
        return index + 1
      }
    }
  }

  return -1
}
