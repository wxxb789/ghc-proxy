import type { Context } from 'hono'

import type { SSEMessage } from 'hono/streaming'

import consola from 'consola'
import { streamSSE } from 'hono/streaming'

import { CopilotClient, isNonStreamingResponse } from '~/clients'
import { getClientConfig, state } from '~/lib/state'
import { getTokenCount } from '~/lib/tokenizer'
import { createUpstreamSignal } from '~/lib/upstream-signal'
import { parseOpenAIChatPayload } from '~/lib/validation'

export async function handleCompletion(c: Context) {
  let payload = parseOpenAIChatPayload(await c.req.json())
  consola.debug('Request payload:', JSON.stringify(payload).slice(-400))

  // Find the selected model
  const selectedModel = state.cache.models?.data.find(
    model => model.id === payload.model,
  )

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info('Current token count:', tokenCount)
    }
    else {
      consola.warn('No model selected, skipping token count calculation')
    }
  }
  catch (error) {
    consola.warn('Failed to calculate token count:', error)
  }

  if (payload.max_tokens == null) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug('Set max_tokens to:', JSON.stringify(payload.max_tokens))
  }

  const { signal, cleanup } = createUpstreamSignal(
    c.req.raw.signal,
    state.config.upstreamTimeoutSeconds !== undefined
      ? state.config.upstreamTimeoutSeconds * 1000
      : undefined,
  )

  const copilotClient = new CopilotClient(state.auth, getClientConfig())
  const response = await copilotClient.createChatCompletions(payload, {
    signal,
  })

  if (isNonStreamingResponse(response)) {
    consola.debug('Non-streaming response:', JSON.stringify(response))
    cleanup()
    return c.json(response)
  }

  consola.debug('Streaming response')
  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of response) {
        consola.debug('Streaming chunk:', JSON.stringify(chunk))
        await stream.writeSSE(chunk as SSEMessage)
      }
    }
    finally {
      cleanup()
    }
  })
}
