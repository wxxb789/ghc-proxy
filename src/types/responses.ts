export interface ResponsesPayload {
  model: string
  instructions?: string | null
  input?: string | Array<ResponseInputItem> | null
  conversation?: ResponseConversation | null
  previous_response_id?: string | null
  tools?: Array<ResponseTool> | null
  tool_choice?: ToolChoiceOptions | ToolChoiceFunction | null
  temperature?: number | null
  top_p?: number | null
  max_output_tokens?: number | null
  max_tool_calls?: number | null
  metadata?: Record<string, string> | null
  stream?: boolean | null
  safety_identifier?: string | null
  prompt_cache_key?: string | null
  truncation?: 'auto' | 'disabled' | null
  parallel_tool_calls?: boolean | null
  store?: boolean | null
  user?: string | null
  prompt?: string | Record<string, unknown> | null
  text?: ResponseTextConfig | null
  reasoning?: ResponseReasoningConfig | null
  context_management?: Array<ResponseContextManagementItem> | null
  include?: Array<ResponseIncludable> | null
  service_tier?: string | null
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

export type ResponseTool = ResponseFunctionTool | Record<string, unknown>

export interface ResponseFunctionTool {
  type: 'function'
  name: string
  parameters: Record<string, unknown> | null
  strict: boolean | null
  description?: string | null
}

export type ResponseIncludable = 'file_search_call.results'
  | 'message.output_text.logprobs'
  | 'message.input_image.image_url'
  | 'computer_call_output.output.image_url'
  | 'reasoning.encrypted_content'
  | 'code_interpreter_call.outputs'
  | 'web_search_call.action.sources'

export type ResponseConversation = string | ResponseConversationReference

export interface ResponseConversationReference {
  id?: string | null
}

export interface ResponseTextConfig {
  format?: ResponseTextFormat | null
  verbosity?: 'low' | 'medium' | 'high' | null
}

export type ResponseTextFormat = ResponseTextFormatText
  | ResponseTextFormatJsonObject
  | ResponseTextFormatJsonSchema

export interface ResponseTextFormatText {
  type: 'text'
}

export interface ResponseTextFormatJsonObject {
  type: 'json_object'
}

export interface ResponseTextFormatJsonSchema {
  type: 'json_schema'
  name: string
  schema: Record<string, unknown>
  description?: string | null
  strict?: boolean | null
}

export interface ResponseReasoningConfig {
  effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null
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
  summary: Array<{
    type: 'summary_text'
    text: string
  }>
  encrypted_content: string
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
  detail: 'low' | 'high' | 'auto'
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
  }
  output_tokens_details?: {
    reasoning_tokens: number
  }
}

export type ResponseStreamEvent = ResponseCompletedEvent
  | ResponseIncompleteEvent
  | ResponseCreatedEvent
  | ResponseErrorEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseFailedEvent
  | ResponseOutputItemAddedEvent
  | ResponseOutputItemDoneEvent
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
