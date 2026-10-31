// Public OpenAI Decisions API and internal System One wire contracts.

export interface DecisionsPromptCacheBreakpoint {
  mode?: 'explicit'
}

export interface DecisionsInputTextPart {
  type: 'input_text'
  text: string
  prompt_cache_breakpoint?: DecisionsPromptCacheBreakpoint | null
}

export interface DecisionsInputImagePart {
  type: 'input_image'
  image_url: string
  detail?: 'low' | 'high' | 'auto' | 'original' | null
  prompt_cache_breakpoint?: DecisionsPromptCacheBreakpoint | null
}

export interface DecisionsInputJsonPart {
  type: 'input_json'
  data: DecisionsJsonObject | Array<DecisionsJsonObject>
}

export interface DecisionsOutputTextPart {
  type: 'output_text'
  text: string
}

export interface DecisionsRefusalPart {
  type: 'refusal'
  refusal: string
}

export type DecisionsInputPart
  = | DecisionsInputTextPart
    | DecisionsInputImagePart
    | DecisionsInputJsonPart
    | DecisionsOutputTextPart
    | DecisionsRefusalPart

export type DecisionsQuestionInputPart
  = | DecisionsInputTextPart
    | DecisionsInputImagePart
    | DecisionsInputJsonPart

export type DecisionsJsonObject = Record<string, unknown>

export type DecisionsMessageRole = 'user' | 'developer' | 'system' | 'assistant'

export type DecisionsMessagePhase = 'commentary' | 'final_answer'

export interface DecisionsMessage {
  type?: 'message'
  role: DecisionsMessageRole
  content: string | Array<DecisionsInputPart>
  phase?: DecisionsMessagePhase | null
}

export type DecisionsToolCallStatus = 'in_progress' | 'completed' | 'incomplete'

export interface DecisionsFunctionCall {
  type: 'function_call'
  arguments: string
  call_id: string
  name: string
  id?: string | null
  namespace?: string | null
  status?: DecisionsToolCallStatus | null
}

export interface DecisionsFunctionCallOutput {
  type: 'function_call_output'
  output: string | Array<DecisionsInputTextPart | DecisionsInputImagePart>
  call_id: string
  id?: string | null
  status?: DecisionsToolCallStatus | null
}

export interface DecisionsCustomToolCall {
  type: 'custom_tool_call'
  input: string
  call_id: string
  name: string
  id?: string | null
  namespace?: string | null
  status?: DecisionsToolCallStatus | null
}

export interface DecisionsCustomToolCallOutput {
  type: 'custom_tool_call_output'
  output: string | Array<DecisionsInputTextPart | DecisionsInputImagePart>
  call_id: string
  id?: string | null
  status?: DecisionsToolCallStatus | null
}

export type DecisionsInputItem
  = | DecisionsMessage
    | DecisionsFunctionCall
    | DecisionsFunctionCallOutput
    | DecisionsCustomToolCall
    | DecisionsCustomToolCallOutput

interface DecisionsQuestionBase {
  name?: string
  instructions: string | Array<DecisionsQuestionInputPart>
}

export interface DecisionsPredicateQuestion extends DecisionsQuestionBase {
  type: 'predicate'
}

export interface DecisionsChoiceQuestion extends DecisionsQuestionBase {
  type: 'choice'
  choices: Array<{
    value: string | boolean
    description?: string
  }>
}

export interface DecisionsScoreQuestion extends DecisionsQuestionBase {
  type: 'score'
  levels: Array<{
    label: string
    description?: string
  }>
}

export type DecisionsQuestion
  = | DecisionsPredicateQuestion
    | DecisionsChoiceQuestion
    | DecisionsScoreQuestion

export interface DecisionsPromptCacheOptions {
  mode?: 'implicit' | 'explicit' | null
  ttl?: '30m'
}

export interface DecisionsRequest {
  model: string
  input: string | Array<DecisionsInputItem>
  questions: Array<DecisionsQuestion>
  safety_identifier?: string | null
  prompt_cache_key?: string | null
  prompt_cache_options?: DecisionsPromptCacheOptions | null
}

export interface DecisionsUsage {
  input_tokens: number
  input_tokens_details: {
    cached_tokens: number
    cache_write_tokens: number
  }
  output_tokens: number
  output_tokens_details: {
    reasoning_tokens: number
  }
  total_tokens: number
}

export interface DecisionsPredicateAnswer {
  type: 'predicate'
  name: string | null
  probability: number
}

export interface DecisionsChoiceAnswer {
  type: 'choice'
  name: string | null
  choice: string | boolean
  confidence: number
  probabilities: Array<{
    value: string | boolean
    probability: number
  }>
}

export interface DecisionsScoreAnswer {
  type: 'score'
  name: string | null
  score: number
  confidence: number
  probabilities: Array<{
    value: number
    label: string
    probability: number
  }>
}

export interface DecisionsRefusalAnswer {
  type: 'refusal'
  name: string | null
}

export type DecisionsAnswer
  = | DecisionsPredicateAnswer
    | DecisionsChoiceAnswer
    | DecisionsScoreAnswer
    | DecisionsRefusalAnswer

export interface DecisionsResponse {
  answers: Array<DecisionsAnswer>
  model: string
  usage: DecisionsUsage
}

export type SystemOneState = string | DecisionsJsonObject | Array<unknown>

export interface SystemOneNoulQuestion {
  type: 'noul'
  instructions?: string
  criteria?: {
    true?: string
    false?: string
  } | null
}

export interface SystemOneChoiceQuestion {
  type: 'choice'
  instructions?: string
  criteria: Record<string, string | null>
}

export interface SystemOneScoreQuestion {
  type: 'score'
  instructions?: string
  criteria: Array<string>
}

export type SystemOneQuestion
  = | SystemOneNoulQuestion
    | SystemOneChoiceQuestion
    | SystemOneScoreQuestion

export interface SystemOneRequest {
  model: string
  state: SystemOneState
  questions: Record<string, SystemOneQuestion>
}

export interface SystemOneNoulAnswer {
  type: 'noul'
  noul: number
}

export interface SystemOneChoiceAnswer {
  type: 'choice'
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

export interface SystemOneScoreAnswer {
  type: 'score'
  score: number
  confidence: number
  legend: Record<string, unknown>
  probabilities: Record<string, number>
}

export interface SystemOneBoxAnswer {
  type: 'box'
  box: {
    top: number
    bottom: number
    left: number
    right: number
  }
  confidence: number | null
}

export interface SystemOneRefusalAnswer {
  type: 'refusal'
}

export type SystemOneAnswer
  = | SystemOneNoulAnswer
    | SystemOneChoiceAnswer
    | SystemOneScoreAnswer
    | SystemOneBoxAnswer
    | SystemOneRefusalAnswer

export interface SystemOneUsage {
  input_tokens: number
  output_tokens: number
  [key: string]: unknown
}

export interface SystemOneResponse {
  model: string
  answers: Record<string, SystemOneAnswer>
  usage: SystemOneUsage
}
