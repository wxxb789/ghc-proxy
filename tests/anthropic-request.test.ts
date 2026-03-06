import { describe, expect, test } from 'bun:test'

import { AnthropicTranslator } from '~/translator'

import {
  anthropicToOpenAIFixtures,
} from './fixtures/anthropic-to-openai'

describe('Anthropic to OpenAI fixture matrix', () => {
  for (const fixture of anthropicToOpenAIFixtures) {
    test(fixture.name, () => {
      const translator = new AnthropicTranslator()
      const result = translator.toOpenAI(fixture.input)

      expect(result).toMatchObject(fixture.expected)
      expect(translator.getLastIssues().map(issue => issue.kind)).toEqual(
        fixture.expectedIssues,
      )
    })
  }
})
