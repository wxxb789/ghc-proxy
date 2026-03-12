#!/usr/bin/env bun

/**
 * Probe ALL /v1/messages models for output_config acceptance.
 * Tests whether older models (without adaptive_thinking) reject output_config.
 *
 * Usage: bun run scripts/probe-all-models-output-config.ts
 */

import process from 'node:process'
import { state } from '~/lib/state'

import { bootstrapProbe, pickMessagesModels, probeMessagesEndpoint, runMain } from './lib/probe-harness'

function baseBody(modelId: string) {
  return {
    model: modelId,
    max_tokens: 32,
    stream: false,
    messages: [{ role: 'user', content: 'Reply OK.' }],
  }
}

const probes = [
  { label: 'baseline', build: (id: string) => baseBody(id) },
  { label: 'output_config.effort=high', build: (id: string) => ({ ...baseBody(id), output_config: { effort: 'high' } }) },
  { label: 'adaptive + output_config', build: (id: string) => ({ ...baseBody(id), thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }) },
  { label: 'thinking:adaptive alone', build: (id: string) => ({ ...baseBody(id), thinking: { type: 'adaptive' } }) },
] as const

runMain(async () => {
  await bootstrapProbe()

  const models = state.cache.models?.data ?? []
  const messagesModels = pickMessagesModels(models)

  process.stdout.write(`\n=== Probing output_config acceptance across ALL /v1/messages models ===\n\n`)
  process.stdout.write(`Found ${messagesModels.length} models with /v1/messages support\n\n`)

  for (const model of messagesModels) {
    const hasAdaptive = model.capabilities.supports.adaptive_thinking ?? false
    process.stdout.write(`--- ${model.id} (adaptive_thinking=${hasAdaptive}) ---\n`)

    for (const probe of probes) {
      const result = await probeMessagesEndpoint(probe.build(model.id))
      const icon = result.status === 'accepted' ? '✓' : '✗'
      const pad = `${probe.label}:`.padEnd(28)
      process.stdout.write(`  ${pad} ${icon} (${result.httpStatus})${result.errorMessage ? ` — ${result.errorMessage}` : ''}\n`)
      await Bun.sleep(300)
    }

    process.stdout.write('\n')
  }
})
