import type { AnthropicResponse } from '~/translator'
import type { ChatCompletionResponse } from '~/types'

export interface OpenAIToAnthropicFixture {
  name: string
  input: ChatCompletionResponse
  expected?: Partial<AnthropicResponse>
  expectedIssues: Array<string>
  expectedError?: {
    kind: string
    status: 400 | 502
  }
}

export const openAIToAnthropicFixtures: Array<OpenAIToAnthropicFixture> = [
  {
    name: 'text-response',
    input: {
      id: 'chatcmpl-text',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello from upstream',
          },
          logprobs: null,
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 12,
        total_tokens: 22,
      },
    },
    expected: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hello from upstream' }],
    },
    expectedIssues: [],
  },
  {
    name: 'tool-call-response',
    input: {
      id: 'chatcmpl-tool',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
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
          logprobs: null,
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 6,
        total_tokens: 14,
      },
    },
    expected: {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'get_weather',
          input: { city: 'Paris' },
        },
      ],
    },
    expectedIssues: [],
  },
  {
    name: 'content-filter-maps-to-refusal',
    input: {
      id: 'chatcmpl-filtered',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
          },
          logprobs: null,
          finish_reason: 'content_filter',
        },
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 0,
        total_tokens: 3,
      },
    },
    expected: {
      stop_reason: 'refusal',
    },
    expectedIssues: [],
  },
  {
    name: 'multiple-choices-picks-first',
    input: {
      id: 'chatcmpl-multi',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o',
      choices: [
        {
          index: 1,
          message: {
            role: 'assistant',
            content: 'second',
          },
          logprobs: null,
          finish_reason: 'stop',
        },
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'first',
          },
          logprobs: null,
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 2,
        total_tokens: 7,
      },
    },
    expected: {
      content: [{ type: 'text', text: 'first' }],
    },
    expectedIssues: ['lossy_multiple_choices_ignored'],
  },
  {
    name: 'malformed-tool-arguments-error',
    input: {
      id: 'chatcmpl-bad-tool',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_bad',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"city"',
                },
              },
            ],
          },
          logprobs: null,
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 2,
        total_tokens: 7,
      },
    },
    expectedIssues: [],
    expectedError: {
      kind: 'invalid_upstream_tool_arguments',
      status: 502,
    },
  },
]
