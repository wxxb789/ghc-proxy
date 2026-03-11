import type { Context } from 'hono'

import type { CapiChatCompletionChunk } from '~/core/capi'
import type { Model, ResponseStreamEvent } from '~/types'
import consola from 'consola'
import { streamSSE } from 'hono/streaming'

import { AnthropicMessagesAdapter, CopilotTransport } from '~/adapters'
import { CopilotClient, isNonStreamingResponse } from '~/clients'
import { readCapiRequestContext } from '~/core/capi'
import { getReasoningEffortForModel } from '~/lib/config'
import { HTTPError } from '~/lib/error'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsEndpoint,
} from '~/lib/model-capabilities'
import { getModelFallbackConfig, resolveModel } from '~/lib/model-resolver'
import { setModelMappingInfo } from '~/lib/request-logger'
import { applyMessagesModelPolicy } from '~/lib/request-model-policy'
import { getClientConfig, state } from '~/lib/state'
import { createUpstreamSignal } from '~/lib/upstream-signal'
import { parseAnthropicMessagesPayload } from '~/lib/validation'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { translateAnthropicToResponsesPayload } from '~/translator/responses/anthropic-to-responses'
import { ResponsesStreamTranslator } from '~/translator/responses/responses-stream-translator'
import { translateResponsesToAnthropic } from '~/translator/responses/responses-to-anthropic'

import { applyContextManagement, compactInputByLatestCompaction, getResponsesRequestOptions } from '../responses/context-management'

const RESPONSES_ENDPOINT = '/responses'
const MESSAGES_ENDPOINT = '/v1/messages'

function createAnthropicAdapter() {
  const knownModelIds = state.cache.models
    ? new Set(state.cache.models.data.map(model => model.id))
    : undefined
  const fallbackConfig = getModelFallbackConfig()

  return new AnthropicMessagesAdapter({
    modelResolver: (model: string) => resolveModel(model, knownModelIds, fallbackConfig),
    getModelCapabilities: model => ({
      supportsThinkingBudget: model.startsWith('claude'),
    }),
  })
}

function toHTTPError(error: TranslationFailure): HTTPError {
  return new HTTPError(
    error.message,
    new Response(error.message, {
      status: error.status,
    }),
  )
}

export async function handleCompletion(c: Context) {
  const anthropicPayload = parseAnthropicMessagesPayload(await c.req.json())
  consola.debug('Anthropic request payload:', JSON.stringify(anthropicPayload))

  const anthropicBetaHeader = c.req.header('anthropic-beta')
  const modelRouting = applyMessagesModelPolicy(
    anthropicPayload,
    anthropicBetaHeader,
  )
  setModelMappingInfo(c, {
    originalModel: modelRouting.originalModel,
    mappedModel: modelRouting.routedModel,
  })

  if (modelRouting.reason) {
    consola.debug(
      `Routed anthropic request to small model via ${modelRouting.reason}:`,
      `${modelRouting.originalModel} -> ${modelRouting.routedModel}`,
    )
  }

  const selectedModel = state.cache.models?.data.find(
    model => model.id === anthropicPayload.model,
  )

  if (shouldUseMessagesApi(selectedModel)) {
    return handleWithMessagesApi(
      c,
      anthropicPayload,
      anthropicBetaHeader,
      selectedModel,
    )
  }

  if (shouldUseResponsesApi(selectedModel)) {
    return handleWithResponsesApi(
      c,
      anthropicPayload,
      modelRouting.originalModel,
      selectedModel,
    )
  }

  return handleWithChatCompletions(c, anthropicPayload, modelRouting.originalModel)
}

async function handleWithChatCompletions(
  c: Context,
  anthropicPayload: ReturnType<typeof parseAnthropicMessagesPayload>,
  originalRequestedModel = anthropicPayload.model,
) {
  const adapter = createAnthropicAdapter()
  let plan
  try {
    plan = adapter.toCapiPlan(anthropicPayload, {
      requestContext: readCapiRequestContext(c.req.raw.headers),
    })
  }
  catch (error) {
    if (error instanceof TranslationFailure) {
      throw toHTTPError(error)
    }
    throw error
  }

  setModelMappingInfo(c, {
    originalModel: originalRequestedModel,
    mappedModel: plan.resolvedModel,
  })
  consola.debug(
    'Claude Code requested model:',
    anthropicPayload.model,
    '-> Copilot model:',
    plan.resolvedModel,
  )
  consola.debug(
    'Planned Copilot request payload:',
    JSON.stringify(plan.payload),
  )

  const { signal, cleanup } = createUpstreamSignal(
    c.req.raw.signal,
    state.config.upstreamTimeoutSeconds !== undefined
      ? state.config.upstreamTimeoutSeconds * 1000
      : undefined,
  )

  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  const transport = new CopilotTransport(copilotClient)
  const response = await transport.execute(plan, { signal })

  if (isNonStreamingResponse(response)) {
    consola.debug(
      'Non-streaming response from Copilot (full):',
      JSON.stringify(response, null, 2),
    )
    try {
      const anthropicResponse = adapter.fromCapiResponse(response)
      consola.debug(
        'Translated Anthropic response:',
        JSON.stringify(anthropicResponse),
      )
      return c.json(anthropicResponse)
    }
    catch (error) {
      if (error instanceof TranslationFailure) {
        throw toHTTPError(error)
      }
      throw error
    }
    finally {
      cleanup()
    }
  }

  consola.debug('Streaming response from Copilot')
  return streamSSE(c, async (stream) => {
    const streamTranslator = adapter.createStreamSerializer()

    try {
      for await (const rawEvent of response) {
        consola.debug('Copilot raw stream event:', JSON.stringify(rawEvent))
        if (rawEvent.data === '[DONE]') {
          const finalEvents = streamTranslator.onDone()
          for (const event of finalEvents) {
            await stream.writeSSE({
              event: event.type,
              data: JSON.stringify(event),
            })
          }
          break
        }

        if (!rawEvent.data) {
          continue
        }

        const chunk = JSON.parse(rawEvent.data) as CapiChatCompletionChunk
        const events = streamTranslator.onChunk(chunk)

        for (const event of events) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }
      }
    }
    catch (error) {
      if (c.req.raw.signal.aborted) {
        consola.debug('Client disconnected during Anthropic stream')
        return
      }

      consola.error('Error streaming Anthropic response:', error)
      const errorEvents = streamTranslator.onError(error)
      for (const event of errorEvents) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
    finally {
      cleanup()
    }
  })
}

async function handleWithResponsesApi(
  c: Context,
  anthropicPayload: ReturnType<typeof parseAnthropicMessagesPayload>,
  originalRequestedModel = anthropicPayload.model,
  selectedModel = state.cache.models?.data.find(
    model => model.id === anthropicPayload.model,
  ),
) {
  let responsesPayload
  try {
    responsesPayload = translateAnthropicToResponsesPayload(anthropicPayload)
  }
  catch (error) {
    if (error instanceof TranslationFailure) {
      throw toHTTPError(error)
    }
    throw error
  }
  setModelMappingInfo(c, {
    originalModel: originalRequestedModel,
    mappedModel: responsesPayload.model,
  })

  applyContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )
  compactInputByLatestCompaction(responsesPayload)

  const { signal, cleanup } = createUpstreamSignal(
    c.req.raw.signal,
    state.config.upstreamTimeoutSeconds !== undefined
      ? state.config.upstreamTimeoutSeconds * 1000
      : undefined,
  )

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  const response = await copilotClient.createResponses(responsesPayload, {
    signal,
    initiator,
    vision,
    requestContext: readCapiRequestContext(c.req.raw.headers),
  })

  if (responsesPayload.stream && isAsyncIterable(response)) {
    return streamSSE(c, async (stream) => {
      const translator = new ResponsesStreamTranslator()

      try {
        for await (const rawEvent of response) {
          if (rawEvent.event === 'ping') {
            await stream.writeSSE({
              event: 'ping',
              data: '{"type":"ping"}',
            })
            continue
          }

          if (!rawEvent.data) {
            continue
          }

          const events = translator.onEvent(
            JSON.parse(rawEvent.data) as ResponseStreamEvent,
          )
          for (const event of events) {
            await stream.writeSSE({
              event: event.type,
              data: JSON.stringify(event),
            })
          }

          if (translator.isCompleted) {
            break
          }
        }

        if (!translator.isCompleted) {
          for (const event of translator.onDone()) {
            await stream.writeSSE({
              event: event.type,
              data: JSON.stringify(event),
            })
          }
        }
      }
      catch (error) {
        if (c.req.raw.signal.aborted) {
          consola.debug('Client disconnected during Responses stream')
          return
        }

        consola.error('Error streaming Anthropic response via Responses API:', error)
        for (const event of translator.onError(error)) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }
      }
      finally {
        cleanup()
      }
    })
  }

  try {
    return c.json(translateResponsesToAnthropic(response as import('~/types').ResponsesResult))
  }
  catch (error) {
    if (error instanceof TranslationFailure) {
      throw toHTTPError(error)
    }
    throw error
  }
  finally {
    cleanup()
  }
}

async function handleWithMessagesApi(
  c: Context,
  anthropicPayload: ReturnType<typeof parseAnthropicMessagesPayload>,
  anthropicBetaHeader: string | undefined,
  selectedModel = state.cache.models?.data.find(
    model => model.id === anthropicPayload.model,
  ),
) {
  filterThinkingBlocksForNativeMessages(anthropicPayload)

  if (modelSupportsAdaptiveThinking(selectedModel)) {
    if (!anthropicPayload.thinking) {
      anthropicPayload.thinking = { type: 'adaptive' }
    }

    if (anthropicPayload.thinking.type !== 'disabled' && !anthropicPayload.output_config?.effort) {
      anthropicPayload.output_config = {
        ...anthropicPayload.output_config,
        effort: getAnthropicEffortForModel(anthropicPayload.model),
      }
    }
  }

  const { signal, cleanup } = createUpstreamSignal(
    c.req.raw.signal,
    state.config.upstreamTimeoutSeconds !== undefined
      ? state.config.upstreamTimeoutSeconds * 1000
      : undefined,
  )

  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  const response = await copilotClient.createMessages(
    anthropicPayload,
    anthropicBetaHeader,
    {
      signal,
      requestContext: readCapiRequestContext(c.req.raw.headers),
    },
  )

  if (isAsyncIterable(response)) {
    return streamSSE(c, async (stream) => {
      try {
        for await (const event of response as AsyncIterable<{
          event?: string
          data?: string
        }>) {
          await stream.writeSSE({
            ...(event.event ? { event: event.event } : {}),
            data: event.data ?? '',
          })
        }
      }
      finally {
        cleanup()
      }
    })
  }

  try {
    return c.json(response)
  }
  finally {
    cleanup()
  }
}

function filterThinkingBlocksForNativeMessages(
  anthropicPayload: ReturnType<typeof parseAnthropicMessagesPayload>,
) {
  for (const message of anthropicPayload.messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue
    }
    message.content = message.content.filter((block) => {
      if (block.type !== 'thinking') {
        return true
      }
      return Boolean(
        block.thinking
        && block.thinking !== 'Thinking...'
        && block.signature
        && !block.signature.includes('@'),
      )
    })
  }
}

function getAnthropicEffortForModel(
  model: string,
): 'low' | 'medium' | 'high' | 'max' {
  const reasoningEffort = getReasoningEffortForModel(model)
  if (reasoningEffort === 'xhigh') {
    return 'max'
  }
  if (reasoningEffort === 'none' || reasoningEffort === 'minimal') {
    return 'low'
  }
  return reasoningEffort
}

function shouldUseResponsesApi(
  selectedModel: Model | undefined,
): boolean {
  return modelSupportsEndpoint(selectedModel, RESPONSES_ENDPOINT)
}

function shouldUseMessagesApi(
  selectedModel: Model | undefined,
): boolean {
  return modelSupportsEndpoint(selectedModel, MESSAGES_ENDPOINT)
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value)
    && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === 'function'
}
