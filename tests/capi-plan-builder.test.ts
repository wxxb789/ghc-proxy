import type { ChatCompletionsPayload } from '~/types'
import { describe, expect, test } from 'bun:test'
import { AnthropicMessagesAdapter, OpenAIChatAdapter } from '~/adapters'

describe('CAPI planning', () => {
  test('Claude anthropic requests add cache checkpoints and stream usage', () => {
    const adapter = new AnthropicMessagesAdapter()
    const plan = adapter.toCapiPlan({
      model: 'claude-sonnet-4-20250514',
      system: 'You are Claude Code.',
      messages: [
        { role: 'assistant', content: 'I can help.' },
        { role: 'user', content: 'Do the thing.' },
      ],
      tools: [
        {
          name: 'read_file',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
          },
        },
        {
          name: 'write_file',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
          },
        },
      ],
      max_tokens: 512,
      stream: true,
    })

    expect(plan.profileId).toBe('claude')
    expect(plan.requestContext.interactionType).toBe('conversation-agent')
    expect(plan.payload.stream_options).toEqual({ include_usage: true })
    expect(plan.payload.messages[0]?.copilot_cache_control).toEqual({ type: 'ephemeral' })
    expect(plan.payload.messages[1]?.copilot_cache_control).toEqual({ type: 'ephemeral' })
    expect(plan.payload.tools?.[1]?.copilot_cache_control).toEqual({ type: 'ephemeral' })
  })

  test('token counting payload strips transport-only fields', () => {
    const adapter = new AnthropicMessagesAdapter()
    const payload = adapter.toTokenCountPayload({
      model: 'claude-sonnet-4-20250514',
      system: 'System prompt',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 64,
      stream: true,
    })

    expect(payload.messages.every(message => !('copilot_cache_control' in message))).toBe(true)
    expect(payload.tools ?? []).toEqual([])
    expect('stream_options' in payload).toBe(false)
  })

  test('planning is deterministic for the same conversation', () => {
    const adapter = new OpenAIChatAdapter()
    const payload: ChatCompletionsPayload = {
      model: 'claude-sonnet-4.5',
      stream: true,
      messages: [
        { role: 'developer', content: 'Follow repo conventions.' },
        { role: 'user', content: 'Implement feature X.' },
      ],
      tools: [
        {
          type: 'function' as const,
          function: {
            name: 'read_file',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
              },
            },
          },
        },
      ],
    }

    const firstPlan = adapter.toCapiPlan(payload)
    const secondPlan = adapter.toCapiPlan(payload)

    expect(JSON.stringify(firstPlan.payload)).toBe(JSON.stringify(secondPlan.payload))
    expect(firstPlan.requestContext.interactionId).not.toBe(secondPlan.requestContext.interactionId)
  })
})
