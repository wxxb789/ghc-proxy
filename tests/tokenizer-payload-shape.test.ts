import type { CapiChatCompletionsPayload } from '~/core/capi'
import type { ChatCompletionsPayload } from '~/types'
import { expect, test } from 'bun:test'
import { getTokenCount } from '~/lib/tokenizer'
import { buildModel } from './helpers'

test('token estimation accepts extended CAPI options without changing message/tool accounting', async () => {
  const model = buildModel('chat-only')
  const chat: ChatCompletionsPayload = {
    model: model.id,
    messages: [{ role: 'user', content: 'Look up the answer.' }],
    tools: [{
      type: 'function',
      function: { name: 'lookup', parameters: { type: 'object', properties: {} } },
    }],
  }
  const capi: CapiChatCompletionsPayload = {
    ...chat,
    parallel_tool_calls: false,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'answer', schema: { type: 'object' }, strict: true },
    },
  }
  const original = structuredClone(capi)
  expect(await getTokenCount(capi, model)).toEqual(await getTokenCount(chat, model))
  expect(capi).toEqual(original)
})
