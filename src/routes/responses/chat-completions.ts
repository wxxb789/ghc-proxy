import type { ResponsesStrategyContext } from './strategy-registry'
import type { CapiChatCompletionResponse } from '~/core/capi'
import type { ExecutionStrategy, SSEStreamChunk } from '~/lib/execution-strategy'
import type { ResponsesChatOutputOptions } from '~/translator/responses/chat-bridge-types'
import consola from 'consola'
import { withTranslationErrors } from '~/lib/error'
import { runtimeStore } from '~/state'
import { ChatToResponsesStreamTranslator, translateChatToResponses } from '~/translator/responses/chat-to-responses'
import { isAsyncIterable } from '~/util/async-iterable'

export function createResponsesViaChatCompletionsStrategy(
  ctx: ResponsesStrategyContext,
): ExecutionStrategy<CapiChatCompletionResponse | AsyncIterable<SSEStreamChunk>, SSEStreamChunk> {
  const request = ctx.chatRequest
  if (!request)
    throw new Error('Responses Chat strategy requires a translated request')
  const options: ResponsesChatOutputOptions = {
    maxOutputTokens: request.plan.payload.max_completion_tokens ?? request.plan.payload.max_tokens ?? undefined,
    mapResponse: ctx.decorateResponse,
    onTranslationIssue(issue) {
      runtimeStore.requests.recordEffect(ctx.requestId, 'responses.chat_translation_lossy')
      consola.warn(`Responses Chat translation: ${issue.kind}`)
    },
    onTerminalResponse: ctx.onTerminalResponse,
    onStreamEndWithoutTerminal: ctx.onStreamEndWithoutTerminal,
  }
  const translator = new ChatToResponsesStreamTranslator(ctx.payload, request.toolMap, options)
  let done = false
  return {
    execute() {
      return ctx.copilotClient.createChatCompletions(request.plan.payload, {
        signal: ctx.upstreamSignal.signal,
        initiator: request.plan.initiator,
        requestContext: request.plan.requestContext,
      })
    },
    isStream: isAsyncIterable,
    translateResult(result) {
      return withTranslationErrors(() => translateChatToResponses(result, ctx.payload, request.toolMap, options))
    },
    translateStreamChunk(chunk) {
      if (ctx.upstreamSignal.clientSignal?.aborted) {
        done = true
        return null
      }
      if (chunk.data === '[DONE]') {
        done = true
        return translator.onDone()
      }
      if (!chunk.data)
        return null
      return translator.onChunk(JSON.parse(chunk.data))
    },
    shouldBreakStream: () => done || translator.isDone,
    onStreamDone: () => ctx.upstreamSignal.clientSignal?.aborted ? null : translator.onDone(),
    onStreamError: error => translator.onError(error),
  }
}
