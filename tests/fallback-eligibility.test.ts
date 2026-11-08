import type { FallbackEligibility } from '~/pipeline/fallback-eligibility'
import type { AnthropicMessagesPayload } from '~/translator'
import type { ChatCompletionsPayload, Model, ResponsesPayload } from '~/types'

import { afterEach, describe, expect, test } from 'bun:test'
import { getCachedConfig } from '~/lib/config'
import { checkChatCompletionsFallbackTarget } from '~/routes/chat-completions/fallback-eligibility'
import { checkMessagesFallbackTarget } from '~/routes/messages/fallback-eligibility'
import { checkResponsesFallbackTarget } from '~/routes/responses/fallback-eligibility'

import { buildModel } from './helpers'

// Overload-fallback eligibility at each endpoint's interface: the pristine
// request payload plus an advertised target in, ok or a rejection reason out.

type Supports = Model['capabilities']['supports']

interface EligibilityCase<TPayload> {
  name: string
  payload: TPayload
  /** Target capability overrides on top of a fully capable target. */
  supports?: Partial<Supports>
  endpoints?: Array<string>
  targetId?: string
  chatBridge?: boolean
  expected: FallbackEligibility
}

function buildTarget(
  { supports, endpoints, targetId }: Pick<EligibilityCase<unknown>, 'supports' | 'endpoints' | 'targetId'>,
  defaultEndpoints: Array<string>,
): Model {
  const target = buildModel(targetId ?? 'target', {
    supported_endpoints: endpoints ?? defaultEndpoints,
  })
  Object.assign(target.capabilities.supports, {
    tool_calls: true,
    parallel_tool_calls: true,
    vision: true,
    adaptive_thinking: true,
    reasoning_effort: ['low', 'medium', 'high'],
    structured_outputs: true,
    ...supports,
  })
  return target
}

const originalChatBridge = getCachedConfig().responsesChatCompletionsFallback

afterEach(() => {
  getCachedConfig().responsesChatCompletionsFallback = originalChatBridge
})

const pngData = 'data:image/png;base64,AA=='
const ok = { ok: true } as const
const rejected = (reason: string): FallbackEligibility => ({ ok: false, reason })

describe('checkChatCompletionsFallbackTarget', () => {
  const base: ChatCompletionsPayload = {
    model: 'source',
    messages: [{ role: 'user', content: 'hi' }],
  }
  const tools: ChatCompletionsPayload['tools'] = [
    { type: 'function', function: { name: 'lookup', parameters: {} } },
  ]
  const cases: Array<EligibilityCase<ChatCompletionsPayload>> = [
    { name: 'plain request', payload: base, expected: ok },
    {
      name: 'tools need tool calls',
      payload: { ...base, tools },
      supports: { tool_calls: false },
      expected: rejected('unsupported-tools'),
    },
    {
      name: 'requested parallel tool calls need parallel support',
      payload: { ...base, tools, parallel_tool_calls: true } as ChatCompletionsPayload,
      supports: { parallel_tool_calls: false },
      expected: rejected('unsupported-parallel-tools'),
    },
    {
      name: 'tools without parallel_tool_calls do not need parallel support',
      payload: { ...base, tools },
      supports: { parallel_tool_calls: false },
      expected: ok,
    },
    {
      name: 'streaming is rejected only when explicitly unsupported',
      payload: { ...base, stream: true },
      supports: { streaming: false },
      expected: rejected('unsupported-streaming'),
    },
    {
      name: 'image parts need vision',
      payload: {
        ...base,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: pngData } }] }],
      },
      supports: { vision: false },
      expected: rejected('unsupported-vision'),
    },
    {
      name: 'reasoning_effort needs effort support',
      payload: { ...base, reasoning_effort: 'high' },
      supports: { reasoning_effort: undefined },
      expected: rejected('unsupported-reasoning'),
    },
    {
      name: 'reasoning_effort none needs nothing',
      payload: { ...base, reasoning_effort: 'none' },
      supports: { reasoning_effort: undefined },
      expected: ok,
    },
    {
      name: 'thinking_budget needs adaptive thinking or effort',
      payload: { ...base, thinking_budget: 1024 },
      supports: { adaptive_thinking: false, reasoning_effort: undefined },
      expected: rejected('unsupported-thinking'),
    },
    {
      name: 'thinking_budget is served by reasoning effort alone',
      payload: { ...base, thinking_budget: 1024 },
      supports: { adaptive_thinking: false },
      expected: ok,
    },
    {
      name: 'json_object needs structured outputs',
      payload: { ...base, response_format: { type: 'json_object' } },
      supports: { structured_outputs: false },
      expected: rejected('unsupported-structured-output'),
    },
    {
      name: 'text response format needs nothing',
      payload: { ...base, response_format: { type: 'text' } } as unknown as ChatCompletionsPayload,
      supports: { structured_outputs: false },
      expected: ok,
    },
  ]

  for (const scenario of cases) {
    test(scenario.name, () => {
      const target = buildTarget(scenario, ['/chat/completions'])
      expect(checkChatCompletionsFallbackTarget(scenario.payload, target)).toEqual(scenario.expected)
    })
  }
})

describe('checkMessagesFallbackTarget', () => {
  const base: AnthropicMessagesPayload = {
    model: 'source',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  }
  const tools: AnthropicMessagesPayload['tools'] = [
    { name: 'lookup', input_schema: { type: 'object', properties: {} } },
  ]
  const format = { type: 'json_schema', schema: { type: 'object', properties: {} } } as const
  const cases: Array<EligibilityCase<AnthropicMessagesPayload>> = [
    { name: 'plain request', payload: base, expected: ok },
    {
      name: 'tools need tool calls',
      payload: { ...base, tools },
      supports: { tool_calls: false },
      expected: rejected('unsupported-tools'),
    },
    {
      name: 'tools alone need parallel tool calls',
      payload: { ...base, tools },
      supports: { parallel_tool_calls: false },
      expected: rejected('unsupported-parallel-tools'),
    },
    {
      name: 'streaming is rejected only when explicitly unsupported',
      payload: { ...base, stream: true },
      supports: { streaming: false },
      expected: rejected('unsupported-streaming'),
    },
    {
      name: 'image blocks need vision',
      payload: {
        ...base,
        messages: [{
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }],
        }],
      },
      supports: { vision: false },
      expected: rejected('unsupported-vision'),
    },
    {
      name: 'output_config.effort needs effort support',
      payload: { ...base, output_config: { effort: 'high' } },
      supports: { reasoning_effort: undefined },
      expected: rejected('unsupported-reasoning'),
    },
    {
      name: 'enabled thinking needs adaptive thinking or effort',
      payload: { ...base, thinking: { type: 'enabled', budget_tokens: 1024 } },
      supports: { adaptive_thinking: false, reasoning_effort: undefined },
      expected: rejected('unsupported-thinking'),
    },
    {
      name: 'adaptive thinking needs adaptive thinking or effort',
      payload: { ...base, thinking: { type: 'adaptive' } },
      supports: { adaptive_thinking: false, reasoning_effort: undefined },
      expected: rejected('unsupported-thinking'),
    },
    {
      name: 'adaptive thinking is served by reasoning effort alone',
      payload: { ...base, thinking: { type: 'adaptive' } },
      supports: { adaptive_thinking: false },
      expected: ok,
    },
    {
      name: 'disabled thinking needs nothing',
      payload: { ...base, thinking: { type: 'disabled' } },
      supports: { adaptive_thinking: false, reasoning_effort: undefined },
      expected: ok,
    },
    {
      name: 'bare format on a native structured-output target',
      payload: { ...base, output_config: { format } },
      endpoints: ['/v1/messages'],
      expected: ok,
    },
    {
      name: 'strict format on a native-only target lands on Chat Completions',
      payload: { ...base, output_config: { format: { ...format, strict: true } } },
      endpoints: ['/v1/messages'],
      expected: rejected('unsupported-structured-output'),
    },
    {
      name: 'described format on a native-only target lands on Chat Completions',
      payload: { ...base, output_config: { format: { ...format, description: 'An answer.' } } },
      endpoints: ['/v1/messages'],
      expected: rejected('unsupported-structured-output'),
    },
    {
      name: 'strict format on a native target with Responses',
      payload: { ...base, output_config: { format: { ...format, strict: true } } },
      endpoints: ['/v1/messages', '/responses'],
      expected: ok,
    },
    {
      name: 'format on a native target without structured outputs',
      payload: { ...base, output_config: { format } },
      endpoints: ['/v1/messages'],
      supports: { structured_outputs: false },
      expected: rejected('unsupported-structured-output'),
    },
    {
      name: 'format on a native target blocked from native structured output',
      payload: { ...base, output_config: { format } },
      endpoints: ['/v1/messages'],
      targetId: 'claude-sonnet-4.6',
      expected: rejected('unsupported-structured-output'),
    },
    {
      name: 'format on a Responses target without a structured_outputs flag',
      payload: { ...base, output_config: { format } },
      endpoints: ['/responses'],
      supports: { structured_outputs: false },
      expected: ok,
    },
    {
      name: 'format on a Chat-only target despite a structured_outputs flag',
      payload: { ...base, output_config: { format } },
      endpoints: ['/chat/completions'],
      expected: rejected('unsupported-structured-output'),
    },
  ]

  for (const scenario of cases) {
    test(scenario.name, () => {
      const target = buildTarget(scenario, ['/v1/messages'])
      expect(checkMessagesFallbackTarget(scenario.payload, target)).toEqual(scenario.expected)
    })
  }
})

describe('checkResponsesFallbackTarget', () => {
  const base: ResponsesPayload = { model: 'source', input: 'hi' }
  const cases: Array<EligibilityCase<ResponsesPayload>> = [
    { name: 'plain request on a native target', payload: base, expected: ok },
    {
      name: 'Chat-only target without the Chat bridge',
      payload: base,
      endpoints: ['/chat/completions'],
      expected: rejected('unsupported-endpoint'),
    },
    {
      name: 'Chat-only target through the Chat bridge',
      payload: base,
      endpoints: ['/chat/completions'],
      chatBridge: true,
      expected: ok,
    },
    {
      name: 'target with neither endpoint',
      payload: base,
      endpoints: ['/v1/messages'],
      chatBridge: true,
      expected: rejected('unsupported-endpoint'),
    },
    {
      name: 'tools need tool calls',
      payload: { ...base, tools: [{ type: 'function', name: 'lookup', parameters: {} }] },
      supports: { tool_calls: false },
      expected: rejected('unsupported-tools'),
    },
    {
      name: 'requested parallel tool calls need parallel support',
      payload: {
        ...base,
        tools: [{ type: 'function', name: 'lookup', parameters: {} }],
        parallel_tool_calls: true,
      },
      supports: { parallel_tool_calls: false },
      expected: rejected('unsupported-parallel-tools'),
    },
    {
      name: 'streaming is rejected only when explicitly unsupported',
      payload: { ...base, stream: true },
      supports: { streaming: false },
      expected: rejected('unsupported-streaming'),
    },
    {
      name: 'input images need vision',
      payload: {
        ...base,
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: pngData, detail: 'auto' }],
        }],
      },
      supports: { vision: false },
      expected: rejected('unsupported-vision'),
    },
    {
      name: 'reasoning effort needs effort support',
      payload: { ...base, reasoning: { effort: 'high' } },
      supports: { reasoning_effort: undefined },
      expected: rejected('unsupported-reasoning'),
    },
    {
      name: 'reasoning effort none needs nothing',
      payload: { ...base, reasoning: { effort: 'none' } },
      supports: { reasoning_effort: undefined },
      expected: ok,
    },
    {
      name: 'JSON mode on the Chat bridge needs no structured outputs',
      payload: { ...base, text: { format: { type: 'json_object' } } },
      endpoints: ['/chat/completions'],
      chatBridge: true,
      supports: { structured_outputs: false },
      expected: ok,
    },
    {
      name: 'JSON schema on the Chat bridge needs structured outputs',
      payload: {
        ...base,
        text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' } } },
      },
      endpoints: ['/chat/completions'],
      chatBridge: true,
      supports: { structured_outputs: false },
      expected: rejected('unsupported-structured-output'),
    },
    {
      name: 'JSON mode on a native target needs structured outputs',
      payload: { ...base, text: { format: { type: 'json_object' } } },
      chatBridge: true,
      supports: { structured_outputs: false },
      expected: rejected('unsupported-structured-output'),
    },
    {
      name: 'text format needs nothing',
      payload: { ...base, text: { format: { type: 'text' } } },
      supports: { structured_outputs: false },
      expected: ok,
    },
  ]

  for (const scenario of cases) {
    test(scenario.name, () => {
      getCachedConfig().responsesChatCompletionsFallback = scenario.chatBridge ?? false
      const target = buildTarget(scenario, ['/responses'])
      expect(checkResponsesFallbackTarget(scenario.payload, target)).toEqual(scenario.expected)
    })
  }
})
