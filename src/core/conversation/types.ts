export type ConversationRole
  = | 'system'
    | 'developer'
    | 'user'
    | 'assistant'
    | 'tool'

export interface ConversationTextBlock {
  kind: 'text'
  text: string
}

export interface ConversationImageBlock {
  kind: 'image'
  url: string
  detail?: 'low' | 'high' | 'auto'
}

export interface ConversationThinkingBlock {
  kind: 'thinking'
  text: string
  signature?: string
}

export interface ConversationToolUseBlock {
  kind: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  argumentsText: string
}

export interface ConversationToolResultBlock {
  kind: 'tool_result'
  toolUseId: string
  content: Array<ConversationTextBlock | ConversationImageBlock>
  isError?: boolean
}

export type ConversationBlock
  = | ConversationTextBlock
    | ConversationImageBlock
    | ConversationThinkingBlock
    | ConversationToolUseBlock
    | ConversationToolResultBlock

export interface ConversationTurnMeta {
  toolCallId?: string
  reasoningOpaque?: string
  encryptedContent?: string | null
  phase?: string
  copilotAnnotations?: unknown
}

export interface ConversationTurn {
  role: ConversationRole
  blocks: Array<ConversationBlock>
  meta?: ConversationTurnMeta
}

export interface ConversationTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export type ConversationToolChoice
  = | { type: 'none' | 'auto' | 'required' }
    | { type: 'tool', name: string }

export type ConversationThinkingConfig
  = | { type: 'disabled' }
    | { type: 'adaptive' }
    | { type: 'enabled', budgetTokens: number }

export interface ConversationRequest {
  model: string
  turns: Array<ConversationTurn>
  maxTokens?: number
  stopSequences?: Array<string>
  stream?: boolean
  temperature?: number | null
  topP?: number | null
  userId?: string
  tools?: Array<ConversationTool>
  toolChoice?: ConversationToolChoice
  thinking?: ConversationThinkingConfig
}
