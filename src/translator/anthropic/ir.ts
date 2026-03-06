import type { AnthropicMessagesPayload, AnthropicResponse } from './types'

export type NormalizedRole = 'system' | 'user' | 'assistant' | 'tool'

export interface NormalizedTurnMeta {
  reasoningOpaque?: string
  encryptedContent?: string | null
  phase?: string
  copilotAnnotations?: unknown
}

export interface NormalizedTextBlock {
  kind: 'text'
  text: string
}

export interface NormalizedImageBlock {
  kind: 'image'
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  data: string
}

export interface NormalizedThinkingBlock {
  kind: 'thinking'
  thinking: string
  signature?: string
}

export interface NormalizedToolUseBlock {
  kind: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface NormalizedToolResultBlock {
  kind: 'tool_result'
  toolUseId: string
  content: Array<NormalizedTextBlock | NormalizedImageBlock>
  isError?: boolean
}

export type NormalizedBlock
  = | NormalizedTextBlock
    | NormalizedImageBlock
    | NormalizedThinkingBlock
    | NormalizedToolUseBlock
    | NormalizedToolResultBlock

export interface NormalizedTurn {
  role: NormalizedRole
  blocks: Array<NormalizedBlock>
  meta?: NormalizedTurnMeta
}

export interface NormalizedToolDefinition {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export type NormalizedToolChoice
  = | { type: 'none' | 'auto' | 'required' }
    | { type: 'tool', name: string }

export type NormalizedThinkingConfig
  = | { type: 'disabled' }
    | { type: 'adaptive' }
    | { type: 'enabled', budgetTokens: number }

export interface NormalizedAnthropicRequest {
  model: string
  turns: Array<NormalizedTurn>
  maxTokens?: number
  stopSequences?: Array<string>
  stream?: boolean
  temperature?: number
  topP?: number
  topK?: number
  userId?: string
  tools?: Array<NormalizedToolDefinition>
  toolChoice?: NormalizedToolChoice
  thinking?: NormalizedThinkingConfig
  serviceTier?: AnthropicMessagesPayload['service_tier']
}

export interface NormalizedOpenAIResponse {
  id: string
  model: string
  turn: NormalizedTurn
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
    }
  }
}

export type AnthropicStopReason = AnthropicResponse['stop_reason']
