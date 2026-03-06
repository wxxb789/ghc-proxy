import type { Context } from 'hono'

import type { CapiChatCompletionChunk } from '~/core/capi'
import consola from 'consola'

import { streamSSE } from 'hono/streaming'

import { AnthropicMessagesAdapter, CopilotTransport } from '~/adapters'
import { CopilotClient, isNonStreamingResponse } from '~/clients'
import { readCapiRequestContext } from '~/core/capi'
import { HTTPError } from '~/lib/error'
import { getModelFallbackConfig, resolveModel } from '~/lib/model-resolver'
import { setModelMappingInfo } from '~/lib/request-logger'
import { getClientConfig, state } from '~/lib/state'
import { createUpstreamSignal } from '~/lib/upstream-signal'
import { parseAnthropicMessagesPayload } from '~/lib/validation'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'

function createAnthropicAdapter() {
  const knownModelIds = state.cache.models
    ? new Set(state.cache.models.data.map(model => model.id))
    : undefined
  const fallbackConfig = getModelFallbackConfig()

  return new AnthropicMessagesAdapter({
    modelResolver: (model: string) => resolveModel(model, knownModelIds, fallbackConfig),
    getModelCapabilities: (model: string) => ({
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
    originalModel: anthropicPayload.model,
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
  const response = await transport.execute(plan, {
    signal,
  })

  if (isNonStreamingResponse(response)) {
    consola.debug(
      'Non-streaming response from Copilot (full):',
      JSON.stringify(response, null, 2),
    )
    let anthropicResponse
    try {
      anthropicResponse = adapter.fromCapiResponse(response)
    }
    catch (error) {
      cleanup()
      if (error instanceof TranslationFailure) {
        throw toHTTPError(error)
      }
      throw error
    }
    consola.debug(
      'Translated Anthropic response:',
      JSON.stringify(anthropicResponse),
    )
    cleanup()
    return c.json(anthropicResponse)
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
          consola.debug('Translated Anthropic event:', JSON.stringify(event))
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
