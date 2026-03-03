import type { Context } from 'hono'

import type { ChatCompletionChunk } from '~/types'
import consola from 'consola'

import { streamSSE } from 'hono/streaming'

import { CopilotClient, isNonStreamingResponse } from '~/clients'
import { setModelMappingInfo } from '~/lib/request-logger'
import { getClientConfig, state } from '~/lib/state'
import { createUpstreamSignal } from '~/lib/upstream-signal'
import { parseAnthropicMessagesPayload } from '~/lib/validation'
import { AnthropicTranslator } from '~/translator'

export async function handleCompletion(c: Context) {
  const anthropicPayload = parseAnthropicMessagesPayload(await c.req.json())
  consola.debug('Anthropic request payload:', JSON.stringify(anthropicPayload))

  const translator = new AnthropicTranslator()
  const openAIPayload = translator.toOpenAI(anthropicPayload)
  setModelMappingInfo(c, {
    originalModel: anthropicPayload.model,
    mappedModel: openAIPayload.model,
  })
  consola.debug(
    'Claude Code requested model:',
    anthropicPayload.model,
    '-> Copilot model:',
    openAIPayload.model,
  )
  consola.debug(
    'Translated OpenAI request payload:',
    JSON.stringify(openAIPayload),
  )

  const { signal, cleanup } = createUpstreamSignal(
    c.req.raw.signal,
    state.config.upstreamTimeoutSeconds !== undefined
      ? state.config.upstreamTimeoutSeconds * 1000
      : undefined,
  )

  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  const response = await copilotClient.createChatCompletions(openAIPayload, {
    signal,
  })

  if (isNonStreamingResponse(response)) {
    consola.debug(
      'Non-streaming response from Copilot (full):',
      JSON.stringify(response, null, 2),
    )
    const anthropicResponse = translator.fromOpenAI(response)
    consola.debug(
      'Translated Anthropic response:',
      JSON.stringify(anthropicResponse),
    )
    cleanup()
    return c.json(anthropicResponse)
  }

  consola.debug('Streaming response from Copilot')
  return streamSSE(c, async (stream) => {
    const streamTranslator = translator.createStreamTranslator()

    try {
      for await (const rawEvent of response) {
        consola.debug('Copilot raw stream event:', JSON.stringify(rawEvent))
        if (rawEvent.data === '[DONE]') {
          break
        }

        if (!rawEvent.data) {
          continue
        }

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
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
