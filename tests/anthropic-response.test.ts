import { describe, expect, test } from 'bun:test'

import { AnthropicMessagesAdapter } from '~/adapters'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'

import {
  openAIStreamFixtures,
} from './fixtures/openai-stream-to-anthropic-stream'
import {
  openAIToAnthropicFixtures,
} from './fixtures/openai-to-anthropic'

describe('OpenAI to Anthropic non-stream fixture matrix', () => {
  for (const fixture of openAIToAnthropicFixtures) {
    test(fixture.name, () => {
      const translator = new AnthropicMessagesAdapter()

      if (fixture.expectedError) {
        expect(() => translator.fromCapiResponse(fixture.input)).toThrow(TranslationFailure)
        try {
          translator.fromCapiResponse(fixture.input)
        }
        catch (error) {
          expect(error).toBeInstanceOf(TranslationFailure)
          const translationError = error as TranslationFailure
          expect(translationError.kind).toBe(fixture.expectedError.kind)
          expect(translationError.status).toBe(fixture.expectedError.status)
        }
        return
      }

      const result = translator.fromCapiResponse(fixture.input)
      expect(result).toMatchObject(fixture.expected!)
      expect(translator.getLastIssues().map(issue => issue.kind)).toEqual(
        fixture.expectedIssues,
      )
    })
  }
})

describe('OpenAI stream to Anthropic stream fixture matrix', () => {
  for (const fixture of openAIStreamFixtures) {
    test(fixture.name, () => {
      const translator = new AnthropicMessagesAdapter()
      const streamTranslator = translator.createStreamSerializer()
      const events = fixture.chunks.flatMap(chunk => streamTranslator.onChunk(chunk))
      events.push(...streamTranslator.onDone())

      expect(events).toEqual(fixture.expectedEvents)
    })
  }
})
