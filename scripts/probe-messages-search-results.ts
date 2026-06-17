#!/usr/bin/env bun

/**
 * Probe script: verify Copilot's native /v1/messages support for
 * Anthropic search_result content blocks.
 *
 * This sends requests directly to Copilot upstream, bypassing ghc-proxy
 * validation and translation.
 *
 * Usage:
 *   bun run scripts/probe-messages-search-results.ts
 *   bun run scripts/probe-messages-search-results.ts --json
 *   bun run scripts/probe-messages-search-results.ts --model=claude-opus-4.8
 *
 * WARNING: Uses real Copilot quota.
 */

import type { Model } from '~/types'

import process from 'node:process'
import { modelCache } from '~/state'

import { parseProbeArgs } from './lib/probe-args'
import { bootstrapProbe, pickMessagesModels, pickModelById, probeMessagesEndpoint, runMain } from './lib/probe-harness'
import { summarizeProbeResults, writeJsonSnapshot } from './lib/probe-report'

const { jsonMode, requestedModelId } = parseProbeArgs()

interface ProbeCase {
  name: string
  body: (modelId: string) => Record<string, unknown>
}

function searchResultBlock(title = 'Probe result') {
  return {
    type: 'search_result',
    source: 'https://example.com/probe',
    title,
    content: [
      {
        type: 'text',
        text: 'This probe result says the required answer is OK.',
      },
    ],
  }
}

function toolDefinition() {
  return {
    name: 'search_docs',
    description: 'Search probe documents.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  }
}

function baselinePayload(modelId: string) {
  return {
    model: modelId,
    max_tokens: 32,
    stream: false,
    messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
  }
}

function toolResultPayload(
  modelId: string,
  content: Array<Record<string, unknown>>,
  extraFields?: Record<string, unknown>,
) {
  return {
    model: modelId,
    max_tokens: 32,
    stream: false,
    tools: [toolDefinition()],
    messages: [
      {
        role: 'user',
        content: 'Search the probe documents.',
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_search_probe',
            name: 'search_docs',
            input: { query: 'probe' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_search_probe',
            content,
          },
          {
            type: 'text',
            text: 'Use the tool result and reply with the single word OK.',
          },
        ],
      },
    ],
    ...extraFields,
  }
}

const cases: Array<ProbeCase> = [
  {
    name: 'baseline',
    body: baselinePayload,
  },
  {
    name: 'top_level_search_result',
    body: modelId => ({
      model: modelId,
      max_tokens: 32,
      stream: false,
      messages: [{
        role: 'user',
        content: [
          searchResultBlock(),
          {
            type: 'text',
            text: 'Use the search result and reply with the single word OK.',
          },
        ],
      }],
    }),
  },
  {
    name: 'top_level_search_result_with_citations',
    body: modelId => ({
      model: modelId,
      max_tokens: 32,
      stream: false,
      citations: { enabled: true },
      messages: [{
        role: 'user',
        content: [
          searchResultBlock('Cited probe result'),
          {
            type: 'text',
            text: 'Use the search result and reply with the single word OK.',
          },
        ],
      }],
    }),
  },
  {
    name: 'tool_result_search_result',
    body: modelId => toolResultPayload(modelId, [searchResultBlock()]),
  },
  {
    name: 'tool_result_mixed_text_search_result',
    body: modelId => toolResultPayload(modelId, [
      { type: 'text', text: 'Tool preface.' },
      searchResultBlock('Mixed probe result'),
    ]),
  },
  {
    name: 'tool_result_search_result_with_citations',
    body: modelId => toolResultPayload(
      modelId,
      [searchResultBlock('Cited tool result')],
      { citations: { enabled: true } },
    ),
  },
]

function selectModel(models: Array<Model>): Model | undefined {
  const messagesModels = pickMessagesModels(models)
  if (requestedModelId) {
    return pickModelById(messagesModels, requestedModelId)
  }
  return messagesModels[0]
}

runMain(async () => {
  await bootstrapProbe({ silent: jsonMode })

  const model = selectModel(modelCache.getModels()?.data ?? [])
  if (!model) {
    process.stderr.write(`No native /v1/messages model found${requestedModelId ? ` matching ${requestedModelId}` : ''}.\n`)
    process.exit(1)
  }

  const results = []
  if (!jsonMode) {
    process.stdout.write('=== Probing Copilot /v1/messages search_result support ===\n')
    process.stdout.write(`Model: ${model.id}\n\n`)
  }

  for (const entry of cases) {
    if (!jsonMode) {
      process.stdout.write(`  Probing: ${entry.name} ... `)
    }

    const result = await probeMessagesEndpoint(entry.body(model.id))
    result.name = entry.name
    results.push(result)

    if (!jsonMode) {
      process.stdout.write(`${result.status.toUpperCase()} (${result.httpStatus ?? 'n/a'})`)
      if (result.errorMessage) {
        process.stdout.write(` - ${result.errorMessage}`)
      }
      process.stdout.write('\n')
    }

    await Bun.sleep(500)
  }

  if (jsonMode) {
    writeJsonSnapshot({
      model: {
        id: model.id,
        supported_endpoints: model.supported_endpoints,
      },
      results,
    })
    return
  }

  const counts = summarizeProbeResults(results)

  process.stdout.write('\n=== Summary ===\n')
  process.stdout.write(`Accepted: ${counts.accepted}\n`)
  process.stdout.write(`Rejected: ${counts.rejected}\n`)
  process.stdout.write(`Errors: ${counts.error}\n`)
})
