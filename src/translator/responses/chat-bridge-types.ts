import type { CapiExecutionPlan } from '~/core/capi'
import type { TranslationIssue } from '~/translator/anthropic/translation-issue'
import type { ResponsesResult } from '~/types'

export interface ResponsesChatTool {
  type: 'function' | 'custom'
  name: string
  namespace?: string
}

export type ResponsesChatToolMap = ReadonlyMap<string, ResponsesChatTool>

export interface ResponsesChatRequest {
  plan: CapiExecutionPlan
  toolMap: ResponsesChatToolMap
  issues: Array<TranslationIssue>
}

export interface ResponsesChatOutputOptions {
  maxOutputTokens?: number
  mapResponse?: (response: ResponsesResult) => ResponsesResult
  onTranslationIssue?: (issue: TranslationIssue) => void
  onTerminalResponse?: (response: ResponsesResult) => void
  onStreamEndWithoutTerminal?: () => void
}
