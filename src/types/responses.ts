export interface ResponsesPayload {
  background?: boolean | null
  model: string
  instructions?: string | null
  input?: string | Array<ResponseInputItem> | null
  conversation?: ResponseConversation | null
  previous_response_id?: string | null
  tools?: Array<ResponseTool> | null
  tool_choice?: ResponseToolChoice | null
  temperature?: number | null
  top_p?: number | null
  /**
   * Not part of the official Responses API — Copilot accepts it as an
   * extension. Probed 2026-07-26: accepted by 9/9 `/responses` models
   * (`scripts/probes/sampling-params.ts`). Only populated by the internal
   * Anthropic-to-Responses translation; client-facing Responses rejects it.
   */
  top_k?: number | null
  max_output_tokens?: number | null
  max_tool_calls?: number | null
  metadata?: Record<string, string> | null
  stream?: boolean | null
  stream_options?: ResponseStreamOptions | null
  safety_identifier?: string | null
  prompt_cache_key?: string | null
  /**
   * Explicit prompt-caching controls. Accepted only by models that support
   * them — probed 2026-07-26: gpt-5.6 returns 200, gpt-5.5 and earlier return
   * `400 prompt_cache_options is not supported on this model`
   * (`scripts/probes/prompt-caching.ts`).
   */
  prompt_cache_options?: {
    mode?: 'implicit' | 'explicit'
    ttl?: '30m'
  } | null
  prompt_cache_retention?: 'in-memory' | '24h' | null
  truncation?: 'auto' | 'disabled' | null
  parallel_tool_calls?: boolean | null
  store?: boolean | null
  user?: string | null
  prompt?: ResponsePrompt | null
  text?: ResponseTextConfig | null
  reasoning?: ResponseReasoningConfig | null
  context_management?: Array<ResponseContextManagementItem> | null
  include?: Array<ResponseIncludable> | null
  service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority' | null
  [key: string]: unknown
}

export interface ResponsesInputTokensPayload extends Omit<ResponsesPayload, 'model'> {
  model?: string | null
}

export type ToolChoiceOptions = 'none' | 'auto' | 'required'

export interface ToolChoiceFunction {
  type: 'function'
  name: string
}

interface ToolChoiceAllowedTools {
  type: 'allowed_tools'
  mode: 'auto' | 'required'
  tools: Array<Record<string, unknown>>
}

interface ToolChoiceBuiltin {
  type: 'file_search' | 'web_search' | 'web_search_2025_08_26' | 'web_search_preview' | 'web_search_preview_2025_03_11' | 'computer_use_preview' | 'code_interpreter' | 'image_generation'
}

interface ToolChoiceMcp {
  type: 'mcp'
  server_label: string
  name?: string
}

interface ToolChoiceCustom {
  type: 'custom'
  name: string
}

interface ToolChoiceApplyPatch {
  type: 'apply_patch'
}

interface ToolChoiceShell {
  type: 'shell'
}

export type ResponseToolChoice = ToolChoiceOptions
  | ToolChoiceAllowedTools
  | ToolChoiceBuiltin
  | ToolChoiceFunction
  | ToolChoiceMcp
  | ToolChoiceCustom
  | ToolChoiceApplyPatch
  | ToolChoiceShell

export type ResponseTool = ResponseFunctionTool | Record<string, unknown>

export interface ResponseFunctionTool {
  type: 'function'
  name: string
  parameters: Record<string, unknown> | null
  strict?: boolean | null
  description?: string | null
}

export type ResponseIncludable = 'file_search_call.results'
  | 'web_search_call.results'
  | 'message.output_text.logprobs'
  | 'message.input_image.image_url'
  | 'computer_call_output.output.image_url'
  | 'reasoning.encrypted_content'
  | 'code_interpreter_call.outputs'
  | 'web_search_call.action.sources'

export type ResponseConversation = string | ResponseConversationReference

export interface ResponseConversationReference {
  id: string
}

export interface ResponsePrompt {
  id: string
  variables?: Record<string, unknown>
  version?: string
}

export interface ResponseStreamOptions {
  include_obfuscation?: boolean | null
}

export interface ResponseTextConfig {
  format?: ResponseTextFormat | null
  verbosity?: 'low' | 'medium' | 'high' | null
}

type ResponseTextFormat = ResponseTextFormatText
  | ResponseTextFormatJsonObject
  | ResponseTextFormatJsonSchema

interface ResponseTextFormatText {
  type: 'text'
}

interface ResponseTextFormatJsonObject {
  type: 'json_object'
}

interface ResponseTextFormatJsonSchema {
  type: 'json_schema'
  name: string
  schema: Record<string, unknown>
  description?: string | null
  strict?: boolean
}

export interface ResponseReasoningConfig {
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  generate_summary?: 'auto' | 'concise' | 'detailed' | null
  summary?: 'auto' | 'concise' | 'detailed' | null
}

export interface ResponseContextManagementCompactionItem {
  type: 'compaction'
  compact_threshold: number
}

export type ResponseContextManagementItem = ResponseContextManagementCompactionItem

export interface ResponseInputMessage {
  type?: 'message'
  role: 'user' | 'assistant' | 'system' | 'developer'
  content?: string | Array<ResponseInputContent>
  status?: string
  phase?: 'commentary' | 'final_answer'
}

export interface ResponseFunctionToolCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
  status?: 'in_progress' | 'completed' | 'incomplete'
}

export interface ResponseFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string | Array<ResponseInputContent>
  status?: 'in_progress' | 'completed' | 'incomplete'
}

export interface ResponseInputReasoning {
  id?: string
  type: 'reasoning'
  summary?: Array<{
    type: 'summary_text'
    text: string
  }>
  encrypted_content?: string | null
  status?: 'in_progress' | 'completed' | 'incomplete'
}

export interface ResponseInputCompaction {
  id: string
  type: 'compaction'
  encrypted_content: string
}

export interface ResponseInputItemReference {
  type: 'item_reference'
  id: string
}

export type ResponseInputItem = ResponseInputMessage
  | ResponseFunctionToolCallItem
  | ResponseFunctionCallOutputItem
  | ResponseInputReasoning
  | ResponseInputCompaction
  | ResponseInputItemReference
  | Record<string, unknown>

export type ResponseInputContent = ResponseInputText
  | ResponseInputImage
  | ResponseInputFile
  | Record<string, unknown>

export interface ResponseInputText {
  type: 'input_text' | 'output_text'
  text: string
}

export interface ResponseInputImage {
  type: 'input_image'
  image_url?: string | null
  file_id?: string | null
  detail?: 'low' | 'high' | 'auto' | 'original'
}

export interface ResponseInputFile {
  type: 'input_file'
  file_id?: string | null
  file_url?: string | null
  file_data?: string | null
  filename?: string | null
}

export interface ResponsesResult {
  id: string
  object: 'response'
  created_at: number
  model: string
  previous_response_id?: string | null
  conversation?: ResponseConversation | null
  output: Array<ResponseOutputItem>
  output_text: string
  status: string
  usage?: ResponseUsage | null
  error: ResponseError | null
  incomplete_details: ResponseIncompleteDetails | null
  instructions: string | null
  metadata: Record<string, string> | null
  parallel_tool_calls: boolean
  temperature: number | null
  tool_choice: unknown
  tools: Array<ResponseTool>
  top_p: number | null
  truncation?: 'auto' | 'disabled' | null
  store?: boolean | null
  user?: string | null
  service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority' | null
}

export interface ResponseIncompleteDetails {
  reason?: 'max_output_tokens' | 'content_filter'
}

export interface ResponseError {
  message: string
}

export interface ResponseDeletionResult {
  id: string
  object?: string
  deleted: boolean
}

export interface ResponseInputItemsListResult {
  object: 'list'
  data: Array<ResponseInputItem | Record<string, unknown>>
  first_id?: string | null
  last_id?: string | null
  has_more?: boolean
}

export interface ResponseInputItemsListParams {
  after?: string
  include?: Array<string>
  limit?: number
  order?: 'asc' | 'desc'
}

export interface ResponseRetrieveParams {
  include?: Array<string>
  include_obfuscation?: boolean
  starting_after?: number
  stream?: boolean
}

export interface ResponseInputTokensResult {
  object: 'response.input_tokens'
  input_tokens: number
}

export type ResponseOutputItem = ResponseOutputMessage
  | ResponseOutputReasoning
  | ResponseOutputFunctionCall
  | ResponseOutputCompaction

export interface ResponseOutputMessage {
  id: string
  type: 'message'
  role: 'assistant'
  status: 'completed' | 'in_progress' | 'incomplete'
  content?: Array<ResponseOutputContentBlock>
}

export interface ResponseOutputReasoning {
  id: string
  type: 'reasoning'
  summary?: Array<ResponseReasoningBlock>
  encrypted_content?: string
  status?: 'completed' | 'in_progress' | 'incomplete'
}

export interface ResponseReasoningBlock {
  type: string
  text?: string
}

export interface ResponseOutputFunctionCall {
  id?: string
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
  status?: 'in_progress' | 'completed' | 'incomplete'
}

export interface ResponseOutputCompaction {
  id: string
  type: 'compaction'
  encrypted_content: string
}

export type ResponseOutputContentBlock = ResponseOutputText
  | ResponseOutputRefusal
  | Record<string, unknown>

export interface ResponseOutputText {
  type: 'output_text'
  text: string
  annotations: Array<unknown>
}

export interface ResponseOutputRefusal {
  type: 'refusal'
  refusal: string
}

export interface ResponseUsage {
  input_tokens: number
  output_tokens?: number
  total_tokens: number
  input_tokens_details?: {
    cached_tokens: number
    /**
     * Tokens written to the prompt cache. Reported only by models with
     * explicit prompt caching — probed 2026-07-26, gpt-5.6 reports it on a
     * cold call while gpt-5.5 always reports 0
     * (`scripts/probes/prompt-caching.ts`).
     */
    cache_write_tokens?: number
  }
  output_tokens_details?: {
    reasoning_tokens: number
  }
}

export type ResponseStreamEvent = ResponseCompletedEvent
  | ResponseIncompleteEvent
  | ResponseCreatedEvent
  | ResponseContentPartAddedEvent
  | ResponseContentPartDoneEvent
  | ResponseErrorEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseFailedEvent
  | ResponseOutputItemAddedEvent
  | ResponseOutputItemDoneEvent
  | ResponseReasoningSummaryPartAddedEvent
  | ResponseReasoningSummaryPartDoneEvent
  | ResponseReasoningSummaryTextDeltaEvent
  | ResponseReasoningSummaryTextDoneEvent
  | ResponseTextDeltaEvent
  | ResponseTextDoneEvent

export interface ResponseCompletedEvent {
  type: 'response.completed'
  sequence_number: number
  response: ResponsesResult
}

export interface ResponseIncompleteEvent {
  type: 'response.incomplete'
  sequence_number: number
  response: ResponsesResult
}

export interface ResponseCreatedEvent {
  type: 'response.created'
  sequence_number: number
  response: ResponsesResult
}

interface ResponseContentPart {
  type: string
  [key: string]: unknown
}

interface ResponseOutputIndexedItemEvent {
  sequence_number: number
  output_index: number
  item_id: string
}

export interface ResponseContentPartAddedEvent extends ResponseOutputIndexedItemEvent {
  type: 'response.content_part.added'
  content_index: number
  part: ResponseContentPart
}

export interface ResponseContentPartDoneEvent extends ResponseOutputIndexedItemEvent {
  type: 'response.content_part.done'
  content_index: number
  part: ResponseContentPart
}

export interface ResponseErrorEvent {
  type: 'error'
  sequence_number: number
  code: string | null
  message: string
  param: string | null
}

export interface ResponseFunctionCallArgumentsDeltaEvent {
  type: 'response.function_call_arguments.delta'
  sequence_number: number
  output_index: number
  item_id: string
  delta: string
}

export interface ResponseFunctionCallArgumentsDoneEvent {
  type: 'response.function_call_arguments.done'
  sequence_number: number
  output_index: number
  item_id: string
  name: string
  arguments: string
}

export interface ResponseFailedEvent {
  type: 'response.failed'
  sequence_number: number
  response: ResponsesResult
}

export interface ResponseOutputItemAddedEvent {
  type: 'response.output_item.added'
  sequence_number: number
  output_index: number
  item: ResponseOutputItem
}

export interface ResponseOutputItemDoneEvent {
  type: 'response.output_item.done'
  sequence_number: number
  output_index: number
  item: ResponseOutputItem
}

export interface ResponseReasoningSummaryPartAddedEvent extends ResponseOutputIndexedItemEvent {
  type: 'response.reasoning_summary_part.added'
  summary_index: number
  part: ResponseReasoningBlock | Record<string, unknown>
}

export interface ResponseReasoningSummaryPartDoneEvent extends ResponseOutputIndexedItemEvent {
  type: 'response.reasoning_summary_part.done'
  summary_index: number
  part: ResponseReasoningBlock | Record<string, unknown>
}

export interface ResponseReasoningSummaryTextDeltaEvent {
  type: 'response.reasoning_summary_text.delta'
  sequence_number: number
  output_index: number
  item_id: string
  summary_index: number
  delta: string
}

export interface ResponseReasoningSummaryTextDoneEvent {
  type: 'response.reasoning_summary_text.done'
  sequence_number: number
  output_index: number
  item_id: string
  summary_index: number
  text: string
}

export interface ResponseTextDeltaEvent {
  type: 'response.output_text.delta'
  sequence_number: number
  output_index: number
  item_id: string
  content_index: number
  delta: string
}

export interface ResponseTextDoneEvent {
  type: 'response.output_text.done'
  sequence_number: number
  output_index: number
  item_id: string
  content_index: number
  text: string
}
