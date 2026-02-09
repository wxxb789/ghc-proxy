import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  TextPart,
  Tool,
  ToolCall,
} from "~/types"

import { getModelFallbackConfig, resolveModel } from "~/lib/model-resolver"
import { state } from "~/lib/state"

import type {
  AnthropicAssistantContentBlock,
  AnthropicAssistantMessage,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUserContentBlock,
  AnthropicUserMessage,
} from "./types"

import { AnthropicStreamTranslator } from "./anthropic-stream-translator"
import { mapOpenAIStopReasonToAnthropic } from "./shared"

export class AnthropicTranslator {
  toOpenAI(payload: AnthropicMessagesPayload): ChatCompletionsPayload {
    return {
      model: this.translateModelName(payload.model),
      messages: this.translateAnthropicMessagesToOpenAI(
        payload.messages,
        payload.system,
      ),
      max_tokens: payload.max_tokens,
      stop: payload.stop_sequences,
      stream: payload.stream,
      temperature: payload.temperature,
      top_p: payload.top_p,
      user: payload.metadata?.user_id,
      tools: this.translateAnthropicToolsToOpenAI(payload.tools),
      tool_choice: this.translateAnthropicToolChoiceToOpenAI(
        payload.tool_choice,
      ),
    }
  }

  fromOpenAI(response: ChatCompletionResponse): AnthropicResponse {
    const allTextBlocks: Array<AnthropicTextBlock> = []
    const allToolUseBlocks: Array<AnthropicToolUseBlock> = []
    let stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null =
      null
    stopReason = response.choices[0]?.finish_reason ?? stopReason

    for (const choice of response.choices) {
      const textBlocks = this.getAnthropicTextBlocks(choice.message.content)
      const toolUseBlocks = this.getAnthropicToolUseBlocks(
        choice.message.tool_calls,
      )

      allTextBlocks.push(...textBlocks)
      allToolUseBlocks.push(...toolUseBlocks)

      if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
        stopReason = choice.finish_reason
      }
    }

    return {
      id: response.id,
      type: "message",
      role: "assistant",
      model: response.model,
      content: [...allTextBlocks, ...allToolUseBlocks],
      stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
      stop_sequence: null,
      usage: {
        input_tokens:
          (response.usage?.prompt_tokens ?? 0)
          - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
        output_tokens: response.usage?.completion_tokens ?? 0,
        ...(response.usage?.prompt_tokens_details?.cached_tokens
          !== undefined && {
          cache_read_input_tokens:
            response.usage.prompt_tokens_details.cached_tokens,
        }),
      },
    }
  }

  createStreamTranslator() {
    return new AnthropicStreamTranslator()
  }

  private translateModelName(model: string): string {
    const knownModelIds =
      state.cache.models ?
        new Set(state.cache.models.data.map((m) => m.id))
      : undefined
    const config = getModelFallbackConfig()
    return resolveModel(model, knownModelIds, config)
  }

  private translateAnthropicMessagesToOpenAI(
    anthropicMessages: Array<AnthropicMessage>,
    system: string | Array<AnthropicTextBlock> | undefined,
  ): Array<Message> {
    const systemMessages = this.handleSystemPrompt(system)

    const otherMessages = anthropicMessages.flatMap((message) =>
      message.role === "user" ?
        this.handleUserMessage(message)
      : this.handleAssistantMessage(message),
    )

    return [...systemMessages, ...otherMessages]
  }

  private handleSystemPrompt(
    system: string | Array<AnthropicTextBlock> | undefined,
  ): Array<Message> {
    if (!system) {
      return []
    }

    if (typeof system === "string") {
      return [{ role: "system", content: system }]
    }

    const systemText = system.map((block) => block.text).join("\n\n")
    return [{ role: "system", content: systemText }]
  }

  private handleUserMessage(message: AnthropicUserMessage): Array<Message> {
    const newMessages: Array<Message> = []

    if (Array.isArray(message.content)) {
      const toolResultBlocks = message.content.filter(
        (block): block is AnthropicToolResultBlock =>
          block.type === "tool_result",
      )
      const otherBlocks = message.content.filter(
        (block) => block.type !== "tool_result",
      )

      for (const block of toolResultBlocks) {
        newMessages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: this.mapContent(block.content),
        })
      }

      if (otherBlocks.length > 0) {
        newMessages.push({
          role: "user",
          content: this.mapContent(otherBlocks),
        })
      }
    } else {
      newMessages.push({
        role: "user",
        content: this.mapContent(message.content),
      })
    }

    return newMessages
  }

  private handleAssistantMessage(
    message: AnthropicAssistantMessage,
  ): Array<Message> {
    if (!Array.isArray(message.content)) {
      return [
        {
          role: "assistant",
          content: this.mapContent(message.content),
        },
      ]
    }

    const toolUseBlocks = message.content.filter(
      (block): block is AnthropicToolUseBlock => block.type === "tool_use",
    )

    const textBlocks = message.content.filter(
      (block): block is AnthropicTextBlock => block.type === "text",
    )

    const thinkingBlocks = message.content.filter(
      (block): block is AnthropicThinkingBlock => block.type === "thinking",
    )

    const allTextContent = [
      ...textBlocks.map((b) => b.text),
      ...thinkingBlocks.map((b) => b.thinking),
    ].join("\n\n")

    return toolUseBlocks.length > 0 ?
        [
          {
            role: "assistant",
            content: allTextContent || null,
            tool_calls: toolUseBlocks.map((toolUse) => ({
              id: toolUse.id,
              type: "function",
              function: {
                name: toolUse.name,
                arguments: JSON.stringify(toolUse.input),
              },
            })),
          },
        ]
      : [
          {
            role: "assistant",
            content: this.mapContent(message.content),
          },
        ]
  }

  private mapContent(
    content:
      | string
      | Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>,
  ): string | Array<ContentPart> | null {
    if (typeof content === "string") {
      return content
    }
    if (!Array.isArray(content)) {
      return null
    }

    const hasImage = content.some((block) => block.type === "image")
    if (!hasImage) {
      return content
        .filter(
          (block): block is AnthropicTextBlock | AnthropicThinkingBlock =>
            block.type === "text" || block.type === "thinking",
        )
        .map((block) => (block.type === "text" ? block.text : block.thinking))
        .join("\n\n")
    }

    const contentParts: Array<ContentPart> = []
    for (const block of content) {
      switch (block.type) {
        case "text": {
          contentParts.push({ type: "text", text: block.text })
          break
        }
        case "thinking": {
          contentParts.push({ type: "text", text: block.thinking })
          break
        }
        case "image": {
          contentParts.push({
            type: "image_url",
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          })
          break
        }
        default: {
          break
        }
      }
    }
    return contentParts
  }

  private translateAnthropicToolsToOpenAI(
    anthropicTools: Array<AnthropicTool> | undefined,
  ): Array<Tool> | undefined {
    if (!anthropicTools) {
      return undefined
    }
    return anthropicTools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }))
  }

  private translateAnthropicToolChoiceToOpenAI(
    anthropicToolChoice: AnthropicMessagesPayload["tool_choice"],
  ): ChatCompletionsPayload["tool_choice"] {
    if (!anthropicToolChoice) {
      return undefined
    }

    switch (anthropicToolChoice.type) {
      case "auto": {
        return "auto"
      }
      case "any": {
        return "required"
      }
      case "tool": {
        if (anthropicToolChoice.name) {
          return {
            type: "function",
            function: { name: anthropicToolChoice.name },
          }
        }
        return undefined
      }
      case "none": {
        return "none"
      }
      default: {
        return undefined
      }
    }
  }

  private getAnthropicTextBlocks(
    messageContent: Message["content"],
  ): Array<AnthropicTextBlock> {
    if (typeof messageContent === "string") {
      return [{ type: "text", text: messageContent }]
    }

    if (Array.isArray(messageContent)) {
      return messageContent
        .filter((part): part is TextPart => part.type === "text")
        .map((part) => ({ type: "text", text: part.text }))
    }

    return []
  }

  private getAnthropicToolUseBlocks(
    toolCalls: Array<ToolCall> | undefined,
  ): Array<AnthropicToolUseBlock> {
    if (!toolCalls) {
      return []
    }
    return toolCalls.map((toolCall) => ({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function.name,
      input: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
    }))
  }
}
