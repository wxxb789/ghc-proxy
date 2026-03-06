import type { AnthropicMessagesPayload } from '~/translator'
import type { ChatCompletionsPayload } from '~/types'

export interface AnthropicToOpenAIFixture {
  name: string
  input: AnthropicMessagesPayload
  expected: Partial<ChatCompletionsPayload>
  expectedIssues: Array<string>
}

export const anthropicToOpenAIFixtures: Array<AnthropicToOpenAIFixture> = [
  {
    name: 'pure-text',
    input: {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 32,
    },
    expected: {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 32,
    },
    expectedIssues: [],
  },
  {
    name: 'image-and-text',
    input: {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'aGVsbG8=',
              },
            },
          ],
        },
      ],
      max_tokens: 64,
    },
    expected: {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image' },
            {
              type: 'image_url',
              image_url: {
                url: 'data:image/png;base64,aGVsbG8=',
              },
            },
          ],
        },
      ],
    },
    expectedIssues: [],
  },
  {
    name: 'tool-result-interleaving',
    input: {
      model: 'claude-sonnet-4-20250514',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'before' },
            { type: 'tool_result', tool_use_id: 'call_1', content: 'tool output' },
            { type: 'text', text: 'after' },
          ],
        },
      ],
      max_tokens: 128,
    },
    expected: {
      messages: [
        { role: 'user', content: 'before' },
        { role: 'tool', tool_call_id: 'call_1', content: 'tool output' },
        { role: 'user', content: 'after' },
      ],
    },
    expectedIssues: [],
  },
  {
    name: 'assistant-thinking-tool-use',
    input: {
      model: 'claude-sonnet-4-20250514',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should reason first.' },
            { type: 'text', text: 'I will call the weather tool.' },
            { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
          ],
        },
      ],
      max_tokens: 128,
    },
    expected: {
      messages: [
        {
          role: 'assistant',
          content: 'I will call the weather tool.',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"city":"Paris"}',
              },
            },
          ],
        },
      ],
    },
    expectedIssues: ['lossy_thinking_omitted_from_prompt'],
  },
  {
    name: 'assistant-interleaved-tool-use',
    input: {
      model: 'claude-sonnet-4-20250514',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'before tool' },
            { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
            { type: 'text', text: 'after tool' },
          ],
        },
      ],
      max_tokens: 128,
    },
    expected: {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'before tool' },
            { type: 'text', text: 'after tool' },
          ],
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"city":"Paris"}',
              },
            },
          ],
        },
      ],
    },
    expectedIssues: ['lossy_interleaving_flattened'],
  },
  {
    name: 'adaptive-thinking-preserves-sampling',
    input: {
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 128,
      temperature: 0.4,
      top_p: 0.95,
      thinking: { type: 'adaptive' },
    },
    expected: {
      temperature: 0.4,
      top_p: 0.95,
      reasoning_effort: 'medium',
      thinking_budget: 24000,
    },
    expectedIssues: [],
  },
  {
    name: 'unsupported-top-k-and-service-tier',
    input: {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 64,
      top_k: 16,
      service_tier: 'auto',
    },
    expected: {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello' }],
    },
    expectedIssues: ['unsupported_top_k', 'unsupported_service_tier'],
  },
]
