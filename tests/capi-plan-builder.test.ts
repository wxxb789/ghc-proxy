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

  test('forwards all completion options to CAPI payload', () => {
    const adapter = new OpenAIChatAdapter()
    const plan = adapter.toCapiPlan({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      n: 2,
      frequency_penalty: 0.5,
      presence_penalty: 0.3,
      logit_bias: { 123: 1, 456: -1 },
      logprobs: true,
      response_format: { type: 'json_object' },
      seed: 42,
    })

    expect(plan.payload.n).toBe(2)
    expect(plan.payload.frequency_penalty).toBe(0.5)
    expect(plan.payload.presence_penalty).toBe(0.3)
    expect(plan.payload.logit_bias).toEqual({ 123: 1, 456: -1 })
    expect(plan.payload.logprobs).toBe(true)
    expect(plan.payload.response_format).toEqual({ type: 'json_object' })
    expect(plan.payload.seed).toBe(42)
  })

  test('explicit reasoning_effort overrides inferred value', () => {
    const adapter = new OpenAIChatAdapter()
    const plan = adapter.toCapiPlan({
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'Think hard' }],
      thinking_budget: 4000,
      reasoning_effort: 'high',
    })

    // thinking_budget 4000 would infer "low", but explicit "high" should win
    expect(plan.payload.reasoning_effort).toBe('high')
  })

  test('omits completion options when not provided or explicitly null', () => {
    const adapter = new OpenAIChatAdapter()
    const keys = ['n', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'logprobs', 'response_format', 'seed'] as const

    const omitted = adapter.toCapiPlan({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    })
    for (const key of keys) {
      expect(key in omitted.payload).toBe(false)
    }

    const nulled = adapter.toCapiPlan({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      n: null,
      frequency_penalty: null,
      response_format: null,
      seed: null,
    })
    for (const key of ['n', 'frequency_penalty', 'response_format', 'seed'] as const) {
      expect(key in nulled.payload).toBe(false)
    }
  })
})
