import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { ChatCompletionChunk, ChatCompletionResponse } from "~/types"

import { CopilotClient } from "~/clients"
import { getClientConfig } from "~/lib/client-config"
import { setModelMappingInfo } from "~/lib/request-logger"
import { state } from "~/lib/state"
import { parseAnthropicMessagesPayload } from "~/lib/validation"
import { AnthropicTranslator } from "~/translator"

export async function handleCompletion(c: Context) {
  const anthropicPayload = parseAnthropicMessagesPayload(await c.req.json())
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const translator = new AnthropicTranslator()
  const openAIPayload = translator.toOpenAI(anthropicPayload)
  setModelMappingInfo(c, {
    originalModel: anthropicPayload.model,
    mappedModel: openAIPayload.model,
  })
  consola.debug(
    "Claude Code requested model:",
    anthropicPayload.model,
    "-> Copilot model:",
    openAIPayload.model,
  )
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  const copilotClient = new CopilotClient(state.auth, getClientConfig(state))
  const response = await copilotClient.createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translator.fromOpenAI(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamTranslator = translator.createStreamTranslator()

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = streamTranslator.onChunk(chunk)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<CopilotClient["createChatCompletions"]>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
