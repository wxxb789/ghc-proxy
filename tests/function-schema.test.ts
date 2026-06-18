import { describe, expect, test } from 'bun:test'

import { normalizeFunctionParametersSchemaForCopilot } from '~/translator/responses/function-schema'

describe('normalizeFunctionParametersSchemaForCopilot', () => {
  test('normalizes plugin and MCP-style object schemas for Copilot Responses validation', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      title: 'nowledge_mem_search arguments',
      properties: {
        query: {
          type: 'string',
          format: 'uri',
          examples: ['https://example.com'],
        },
        options: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              default: 10,
            },
            tags: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  value: {
                    type: 'string',
                    format: 'uri',
                  },
                },
              },
            },
          },
        },
      },
    }

    expect(normalizeFunctionParametersSchemaForCopilot(schema)).toEqual({
      type: 'object',
      properties: {
        query: {
          type: 'string',
        },
        options: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
            },
            tags: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  value: {
                    type: 'string',
                  },
                },
                required: ['value'],
                additionalProperties: false,
              },
            },
          },
          required: ['limit', 'tags'],
          additionalProperties: false,
        },
      },
      required: ['query', 'options'],
      additionalProperties: false,
    })
  })

  test('passes through nullish schemas unchanged', () => {
    expect(normalizeFunctionParametersSchemaForCopilot(undefined)).toBeUndefined()
    expect(normalizeFunctionParametersSchemaForCopilot(null)).toBeNull()
  })
})
