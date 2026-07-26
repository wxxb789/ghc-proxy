// Anthropic API Types

export interface AnthropicMessagesPayload {
  model: string
  messages: Array<AnthropicMessage>
  max_tokens: number
  system?: string | Array<AnthropicTextBlock>
  metadata?: {
    user_id?: string
  }
  stop_sequences?: Array<string>
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  tools?: Array<AnthropicTool>
  tool_choice?: {
    type: 'auto' | 'any' | 'tool' | 'none'
    name?: string
  }
  thinking?:
    | { type: 'enabled', budget_tokens: number }
    | { type: 'disabled' }
    | { type: 'adaptive' }
  output_config?: {
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
    format?: AnthropicOutputFormat
  }
  service_tier?: 'auto' | 'standard_only'
}

export type AnthropicCountTokensPayload = Omit<
  AnthropicMessagesPayload,
  'max_tokens'
> & {
  max_tokens?: number
}

export interface AnthropicJsonSchemaOutputFormat {
  type: 'json_schema'
  schema: Record<string, unknown>
  name?: string
  description?: string | null
  strict?: boolean
}

export type AnthropicOutputFormat = AnthropicJsonSchemaOutputFormat

export interface AnthropicTextBlock {
  type: 'text'
  text: string
}

export interface AnthropicImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
    data: string
  }
}

export interface AnthropicDocumentBlock {
  type: 'document'
  // Kept loose deliberately for now. A discriminated `AnthropicDocumentSource`
  // union is a candidate but UNVERIFIED — verify/design first (see docs/TODO.md, Research).
  source: Record<string, unknown>
}

export interface AnthropicSearchResultBlock {
  type: 'search_result'
  source: string
  title: string
  content: Array<AnthropicTextBlock>
  citations?: unknown
  cache_control?: unknown
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<AnthropicToolResultContentBlock>
  is_error?: boolean
}

export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicServerToolUseBlock {
  type: 'server_tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicMcpToolUseBlock {
  type: 'mcp_tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  server_name: string
}

export interface AnthropicThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface AnthropicRedactedThinkingBlock {
  type: 'redacted_thinking'
  data: string
}

export type AnthropicServerToolResultType
  = | 'server_tool_result'
    | 'web_search_tool_result'
    | 'web_fetch_tool_result'
    | 'code_execution_tool_result'
    | 'bash_code_execution_tool_result'
    | 'text_editor_code_execution_tool_result'
    | 'tool_search_tool_result'

export interface AnthropicServerToolResultBlock {
  type: AnthropicServerToolResultType
  tool_use_id: string
  content: unknown
  is_error?: boolean
}

export interface AnthropicMcpToolResultBlock {
  type: 'mcp_tool_result'
  tool_use_id: string
  content: string | Array<AnthropicToolResultContentBlock>
  is_error?: boolean
}

export type AnthropicToolResultContentBlock
  = | AnthropicTextBlock
    | AnthropicImageBlock
    | AnthropicSearchResultBlock
    | AnthropicDocumentBlock

export type AnthropicUserContentBlock
  = | AnthropicTextBlock
    | AnthropicImageBlock
    | AnthropicSearchResultBlock
    | AnthropicToolResultBlock
    | AnthropicDocumentBlock
    | AnthropicServerToolResultBlock
    | AnthropicMcpToolResultBlock

export type AnthropicSystemContentBlock = AnthropicTextBlock

export type AnthropicAssistantContentBlock
  = | AnthropicTextBlock
    | AnthropicToolUseBlock
    | AnthropicServerToolUseBlock
    | AnthropicMcpToolUseBlock
    | AnthropicThinkingBlock
    | AnthropicRedactedThinkingBlock
    | AnthropicServerToolResultBlock
    | AnthropicMcpToolResultBlock

export interface AnthropicUserMessage {
  role: 'user'
  content: string | Array<AnthropicUserContentBlock>
}

export interface AnthropicAssistantMessage {
  role: 'assistant'
  content: string | Array<AnthropicAssistantContentBlock>
}

export interface AnthropicSystemMessage {
  role: 'system'
  content: string | Array<AnthropicSystemContentBlock>
}

export type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage | AnthropicSystemMessage

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: Array<AnthropicAssistantContentBlock>
  model: string
  stop_reason:
    | 'end_turn'
    | 'max_tokens'
    | 'stop_sequence'
    | 'tool_use'
    | 'pause_turn'
    | 'refusal'
    | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    service_tier?: 'standard' | 'priority' | 'batch'
  }
}

export type AnthropicResponseContentBlock = AnthropicAssistantContentBlock

// Anthropic Stream Event Types
export interface AnthropicMessageStartEvent {
  type: 'message_start'
  message: Omit<
    AnthropicResponse,
    'content' | 'stop_reason' | 'stop_sequence'
  > & {
    content: []
    stop_reason: null
    stop_sequence: null
  }
}

export interface AnthropicContentBlockStartEvent {
  type: 'content_block_start'
  index: number
  content_block:
    | { type: 'text', text: string }
    | (Omit<AnthropicToolUseBlock, 'input'> & {
      input: Record<string, unknown>
    })
    | { type: 'thinking', thinking: string }
}

export interface AnthropicContentBlockDeltaEvent {
  type: 'content_block_delta'
  index: number
  delta:
    | { type: 'text_delta', text: string }
    | { type: 'input_json_delta', partial_json: string }
    | { type: 'thinking_delta', thinking: string }
    | { type: 'signature_delta', signature: string }
}

export interface AnthropicContentBlockStopEvent {
  type: 'content_block_stop'
  index: number
}

export interface AnthropicMessageDeltaEvent {
  type: 'message_delta'
  delta: {
    stop_reason?: AnthropicResponse['stop_reason']
    stop_sequence?: string | null
  }
  usage?: {
    input_tokens?: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export interface AnthropicMessageStopEvent {
  type: 'message_stop'
}

export interface AnthropicPingEvent {
  type: 'ping'
}

export interface AnthropicErrorEvent {
  type: 'error'
  error: {
    type: string
    message: string
  }
}

export type AnthropicStreamEventData
  = | AnthropicMessageStartEvent
    | AnthropicContentBlockStartEvent
    | AnthropicContentBlockDeltaEvent
    | AnthropicContentBlockStopEvent
    | AnthropicMessageDeltaEvent
    | AnthropicMessageStopEvent
    | AnthropicPingEvent
    | AnthropicErrorEvent

// State for streaming translation
export interface AnthropicStreamState {
  messageStartSent: boolean
  nextContentBlockIndex: number
  openTextBlockIndex: number | null
  openThinkingBlockIndex: number | null
  toolCalls: Record<number, AnthropicStreamToolCallState>
  lastUsage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens?: number
      rejected_prediction_tokens?: number
    }
  }
  pendingStopReason?:
    | 'stop'
    | 'length'
    | 'tool_calls'
    | 'content_filter'
    | null
  messageStopSent: boolean
}

export interface AnthropicStreamToolCallState {
  id?: string
  name?: string
  anthropicBlockIndex?: number
  started: boolean
  closed: boolean
}
