import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Message,
  Tool,
  ToolCall,
} from '~/types'

export type CapiInteractionType
  = | 'conversation-agent'
    | 'conversation-subagent'
    | 'conversation-background'
    | 'conversation-user'

export interface CapiRequestContext {
  interactionType: CapiInteractionType
  agentTaskId?: string
  parentAgentTaskId?: string
  clientSessionId?: string
  interactionId?: string
  clientMachineId?: string
}

export interface CopilotCacheControl {
  type: 'ephemeral'
}

export interface CapiStreamOptions {
  include_usage?: boolean
}

export interface CapiMessage extends Omit<Message, 'tool_calls'> {
  tool_calls?: Array<ToolCall>
  copilot_cache_control?: CopilotCacheControl
  reasoning_text?: string | null
  reasoning_opaque?: string
  encrypted_content?: string | null
  phase?: string
  copilot_annotations?: unknown
}

export interface CapiTool extends Tool {
  copilot_cache_control?: CopilotCacheControl
}

export interface CapiFunctionTool extends Omit<Tool['function'], 'parameters'> {
  parameters: Record<string, unknown>
  strict?: boolean
}

export interface CapiResponseFormatJsonSchema {
  type: 'json_schema'
  json_schema: {
    name: string
    schema: Record<string, unknown>
    description?: string
    strict?: boolean
  }
}

export type CapiResponseFormat
  = | { type: 'json_object' }
    | CapiResponseFormatJsonSchema

export type CapiToolWithStrict = Omit<CapiTool, 'function'> & {
  function: CapiFunctionTool
}

export interface CapiChatCompletionsPayload
  extends Omit<ChatCompletionsPayload, 'messages' | 'tools' | 'response_format'> {
  messages: Array<CapiMessage>
  tools?: Array<CapiToolWithStrict> | null
  response_format?: CapiResponseFormat | null
  stream_options?: CapiStreamOptions | null
  parallel_tool_calls?: boolean | null
  max_completion_tokens?: number | null
  /**
   * Not part of the OpenAI chat schema — Copilot accepts it as an extension.
   * Probed 2026-07-26: accepted by every reachable model on both
   * `/chat/completions` and `/v1/messages`
   * (`scripts/probes/sampling-params.ts`). Only populated by the internal
   * Anthropic-to-CAPI translation; client-facing OpenAI Chat rejects it.
   */
  top_k?: number | null
}

export interface CapiResponseMessage
  extends Omit<ChatCompletionResponse['choices'][number]['message'], 'tool_calls'> {
  tool_calls?: Array<ToolCall>
  reasoning_text?: string | null
  reasoning_opaque?: string
  encrypted_content?: string | null
  phase?: string
  copilot_annotations?: unknown
}

export interface CapiChatCompletionResponse
  extends Omit<ChatCompletionResponse, 'choices'> {
  choices: Array<
    Omit<ChatCompletionResponse['choices'][number], 'message'> & {
      message: CapiResponseMessage
    }
  >
  copilot_usage?: unknown
}

export interface CapiChunkDelta
  extends Omit<ChatCompletionChunk['choices'][number]['delta'], 'tool_calls' | 'role'> {
  role?: CapiMessage['role']
  tool_calls?: Array<
    NonNullable<ChatCompletionChunk['choices'][number]['delta']['tool_calls']>[number]
  >
  reasoning_text?: string | null
  reasoning_opaque?: string
  encrypted_content?: string | null
  phase?: string
  copilot_annotations?: unknown
}

export interface CapiChatCompletionChunk
  extends Omit<ChatCompletionChunk, 'choices'> {
  choices: Array<
    Omit<ChatCompletionChunk['choices'][number], 'delta'> & {
      delta: CapiChunkDelta
    }
  >
  copilot_usage?: unknown
}

export interface CapiExecutionPlan {
  payload: CapiChatCompletionsPayload
  tokenCountPayload: CapiChatCompletionsPayload
  requestContext: CapiRequestContext
  initiator: 'user' | 'agent'
  profileId: 'base' | 'claude'
  resolvedModel: string
}
