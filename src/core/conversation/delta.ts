export interface ConversationUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
  }
}

export interface ConversationDeltaMetadata {
  reasoningOpaque?: string
  encryptedContent?: string | null
  phase?: string
  copilotAnnotations?: unknown
}

export type ConversationStopReason
  = | 'stop'
    | 'length'
    | 'tool_calls'
    | 'content_filter'
    | null

export type ConversationDelta
  = | {
    kind: 'message_start'
    id: string
    model: string
    usage?: ConversationUsage
  }
  | {
    kind: 'text_delta'
    text: string
  }
  | {
    kind: 'thinking_delta'
    text: string
    metadata?: ConversationDeltaMetadata
  }
  | {
    kind: 'tool_use_delta'
    toolIndex: number
    id?: string
    name?: string
    argumentsText?: string
  }
  | {
    kind: 'message_stop'
    stopReason: ConversationStopReason
    usage?: ConversationUsage
    metadata?: ConversationDeltaMetadata
  }
