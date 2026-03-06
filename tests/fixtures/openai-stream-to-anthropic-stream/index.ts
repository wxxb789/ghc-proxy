import type { AnthropicStreamEventData } from '~/translator'
import type { ChatCompletionChunk } from '~/types'

export interface OpenAIStreamFixture {
  name: string
  chunks: Array<ChatCompletionChunk>
  expectedEvents: Array<AnthropicStreamEventData>
}

export const openAIStreamFixtures: Array<OpenAIStreamFixture> = [
  {
    name: 'simple-text',
    chunks: [
      {
        id: 's1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null, logprobs: null }],
      },
      {
        id: 's1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null, logprobs: null }],
      },
      {
        id: 's1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop', logprobs: null }],
      },
    ],
    expectedEvents: [
      {
        type: 'message_start',
        message: {
          id: 's1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'gpt-4o',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'text',
          text: '',
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'Hello',
        },
      },
      {
        type: 'content_block_stop',
        index: 0,
      },
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
      },
      {
        type: 'message_stop',
      },
    ],
  },
  {
    name: 'thinking-then-text',
    chunks: [
      {
        id: 's2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null, logprobs: null }],
      },
      {
        id: 's2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { reasoning_text: 'Reasoning...' }, finish_reason: null, logprobs: null }],
      },
      {
        id: 's2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { content: 'Answer' }, finish_reason: 'stop', logprobs: null }],
      },
    ],
    expectedEvents: [
      {
        type: 'message_start',
        message: {
          id: 's2',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'gpt-4o',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'thinking',
          thinking: '',
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'thinking_delta',
          thinking: 'Reasoning...',
        },
      },
      {
        type: 'content_block_stop',
        index: 0,
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'text',
          text: '',
        },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'text_delta',
          text: 'Answer',
        },
      },
      {
        type: 'content_block_stop',
        index: 1,
      },
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
      },
      {
        type: 'message_stop',
      },
    ],
  },
  {
    name: 'interleaved-tool-deltas',
    chunks: [
      {
        id: 's3',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null, logprobs: null }],
      },
      {
        id: 's3',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_a',
                  type: 'function',
                  function: { name: 'a', arguments: '{"x"' },
                },
                {
                  index: 1,
                  id: 'call_b',
                  type: 'function',
                  function: { name: 'b', arguments: '{"y"' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: 's3',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, function: { arguments: ':2}' } },
                { index: 0, function: { arguments: ':1}' } },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
    ],
    expectedEvents: [
      {
        type: 'message_start',
        message: {
          id: 's3',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'gpt-4o',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_a',
          name: 'a',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"x"',
        },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'call_b',
          name: 'b',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"y"',
        },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: ':2}',
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: ':1}',
        },
      },
      {
        type: 'content_block_stop',
        index: 0,
      },
      {
        type: 'content_block_stop',
        index: 1,
      },
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
      },
      {
        type: 'message_stop',
      },
    ],
  },
  {
    name: 'done-without-finish',
    chunks: [
      {
        id: 's4',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null, logprobs: null }],
      },
      {
        id: 's4',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null, logprobs: null }],
      },
    ],
    expectedEvents: [
      {
        type: 'message_start',
        message: {
          id: 's4',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'gpt-4o',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'text',
          text: '',
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'partial',
        },
      },
      {
        type: 'content_block_stop',
        index: 0,
      },
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
      },
      {
        type: 'message_stop',
      },
    ],
  },
]
