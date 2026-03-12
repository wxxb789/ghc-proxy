#!/usr/bin/env bun

/**
 * Probe script: discover which reasoning-effort-related fields
 * Copilot's native /v1/messages endpoint accepts.
 *
 * This script sends requests DIRECTLY to Copilot's upstream /v1/messages
 * endpoint (bypassing all proxy handler logic) with various field
 * combinations to map out the accepted schema.
 *
 * Usage: bun run scripts/probe-messages-fields.ts [--json]
 */

import type { ProbeResult } from './lib/probe-harness'

import process from 'node:process'
import { state } from '~/lib/state'

import { bootstrapProbe, pickFirstMessagesModel, probeMessagesEndpoint, runMain } from './lib/probe-harness'

const jsonMode = Bun.argv.includes('--json')

function basePayload(modelId: string) {
  return {
    model: modelId,
    max_tokens: 32,
    stream: false as const,
    messages: [{ role: 'user' as const, content: 'Reply with the single word OK.' }],
  }
}

function buildProbes(modelId: string): Array<{ name: string, body: Record<string, unknown> }> {
  const base = basePayload(modelId)
  return [
    { name: 'baseline (no extras)', body: base },

    // output_config variants (Anthropic official)
    { name: 'output_config.effort = high', body: { ...base, output_config: { effort: 'high' } } },
    { name: 'output_config.effort = low', body: { ...base, output_config: { effort: 'low' } } },
    { name: 'output_config.effort = max', body: { ...base, output_config: { effort: 'max' } } },

    // thinking + output_config combined
    { name: 'thinking:adaptive + output_config.effort=high', body: { ...base, thinking: { type: 'adaptive' }, output_config: { effort: 'high' } } },
    { name: 'thinking:adaptive (alone)', body: { ...base, thinking: { type: 'adaptive' } } },
    { name: 'thinking:disabled (alone)', body: { ...base, thinking: { type: 'disabled' } } },
    { name: 'thinking:disabled + output_config.effort=high', body: { ...base, thinking: { type: 'disabled' }, output_config: { effort: 'high' } } },

    // reasoning_effort (OpenAI Chat Completions style)
    { name: 'reasoning_effort = high', body: { ...base, reasoning_effort: 'high' } },
    { name: 'reasoning_effort = low', body: { ...base, reasoning_effort: 'low' } },
    { name: 'reasoning_effort = medium', body: { ...base, reasoning_effort: 'medium' } },

    // reasoning (Responses API style)
    { name: 'reasoning.effort = high', body: { ...base, reasoning: { effort: 'high' } } },

    // thinking:enabled with budget
    { name: 'thinking:enabled + budget_tokens=1024', body: { ...base, thinking: { type: 'enabled', budget_tokens: 1024 } } },

    // mixing styles
    { name: 'thinking:adaptive + reasoning_effort=high', body: { ...base, thinking: { type: 'adaptive' }, reasoning_effort: 'high' } },
    { name: 'thinking:adaptive + reasoning_effort=low', body: { ...base, thinking: { type: 'adaptive' }, reasoning_effort: 'low' } },

    // Bogus field to confirm strict validation
    { name: 'bogus_field (confirm strict validation)', body: { ...base, bogus_field_xyz: true } },
  ]
}

runMain(async () => {
  await bootstrapProbe({ silent: jsonMode })

  const models = state.cache.models?.data ?? []
  const model = pickFirstMessagesModel(models)
  if (!model) {
    process.stderr.write('No model with /v1/messages support found.\n')
    process.exit(1)
  }

  if (!jsonMode) {
    process.stdout.write(`\n=== Probing Copilot /v1/messages field acceptance ===\n`)
    process.stdout.write(`Model: ${model.id}\n`)
    process.stdout.write(`Supported endpoints: ${model.supported_endpoints?.join(', ')}\n`)
    process.stdout.write(`Adaptive thinking: ${model.capabilities.supports.adaptive_thinking}\n`)
    process.stdout.write(`Reasoning effort values: ${JSON.stringify(model.capabilities.supports.reasoning_effort)}\n\n`)
  }

  const probes = buildProbes(model.id)
  const base = basePayload(model.id)
  const results: Array<ProbeResult> = []

  for (const probe of probes) {
    if (!jsonMode) {
      process.stdout.write(`  Probing: ${probe.name} ... `)
    }

    const result = await probeMessagesEndpoint(probe.body, base)
    result.name = probe.name
    results.push(result)

    if (!jsonMode) {
      const icon = result.status === 'accepted' ? '✓' : result.status === 'rejected' ? '✗' : '!'
      process.stdout.write(`${icon} ${result.status} (${result.httpStatus ?? 'n/a'})`)
      if (result.errorMessage) {
        process.stdout.write(` — ${result.errorMessage}`)
      }
      process.stdout.write('\n')
    }

    await Bun.sleep(500)
  }

  if (jsonMode) {
    await Bun.write(Bun.stdout, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      model: {
        id: model.id,
        supported_endpoints: model.supported_endpoints,
        adaptive_thinking: model.capabilities.supports.adaptive_thinking,
        reasoning_effort: model.capabilities.supports.reasoning_effort,
      },
      results,
    }, null, 2)}\n`)
  }
  else {
    process.stdout.write('\n=== Summary ===\n')
    const accepted = results.filter(r => r.status === 'accepted')
    const rejected = results.filter(r => r.status === 'rejected')

    process.stdout.write(`\nAccepted fields (${accepted.length}):\n`)
    for (const r of accepted) {
      process.stdout.write(`  ✓ ${r.name}\n`)
    }
    process.stdout.write(`\nRejected fields (${rejected.length}):\n`)
    for (const r of rejected) {
      process.stdout.write(`  ✗ ${r.name}: ${r.errorMessage}\n`)
    }
  }
})
