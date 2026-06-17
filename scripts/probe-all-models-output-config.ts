#!/usr/bin/env bun

/**
 * Probe ALL /v1/messages models for output_config acceptance.
 * Tests whether older models (without adaptive_thinking) reject output_config.
 *
 * Usage:
 *   bun run scripts/probe-all-models-output-config.ts
 *   bun run scripts/probe-all-models-output-config.ts --json
 */

import process from 'node:process'
import { modelCache } from '~/state'

import { parseProbeArgs } from './lib/probe-args'
import { bootstrapProbe, pickMessagesModels, probeMessagesEndpoint, runMain } from './lib/probe-harness'
import { statusIcon, writeJsonSnapshot } from './lib/probe-report'

const { jsonMode } = parseProbeArgs()

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
  { label: 'output_config.effort=null', build: (id: string) => ({ ...baseBody(id), output_config: { effort: null } }) },
  { label: 'adaptive + output_config', build: (id: string) => ({ ...baseBody(id), thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }) },
  { label: 'thinking:adaptive alone', build: (id: string) => ({ ...baseBody(id), thinking: { type: 'adaptive' } }) },
] as const

runMain(async () => {
  await bootstrapProbe({ silent: jsonMode })

  const models = modelCache.getModels()?.data ?? []
  const messagesModels = pickMessagesModels(models)

  if (!jsonMode) {
    process.stdout.write(`\n=== Probing output_config acceptance across ALL /v1/messages models ===\n\n`)
    process.stdout.write(`Found ${messagesModels.length} models with /v1/messages support\n\n`)
  }

  const snapshot: Array<{
    model: string
    adaptive_thinking: boolean
    probes: Array<{ label: string, status: string, httpStatus?: number, errorMessage?: string }>
  }> = []

  for (const model of messagesModels) {
    const hasAdaptive = model.capabilities.supports.adaptive_thinking ?? false
    if (!jsonMode) {
      process.stdout.write(`--- ${model.id} (adaptive_thinking=${hasAdaptive}) ---\n`)
    }

    const modelProbes: (typeof snapshot)[number]['probes'] = []
    for (const probe of probes) {
      const result = await probeMessagesEndpoint(probe.build(model.id))
      modelProbes.push({
        label: probe.label,
        status: result.status,
        httpStatus: result.httpStatus,
        errorMessage: result.errorMessage,
      })
      if (!jsonMode) {
        const pad = `${probe.label}:`.padEnd(28)
        process.stdout.write(`  ${pad} ${statusIcon(result.status)} (${result.httpStatus})${result.errorMessage ? ` — ${result.errorMessage}` : ''}\n`)
      }
      await Bun.sleep(300)
    }

    snapshot.push({ model: model.id, adaptive_thinking: hasAdaptive, probes: modelProbes })
    if (!jsonMode) {
      process.stdout.write('\n')
    }
  }

  if (jsonMode) {
    writeJsonSnapshot({ models: snapshot })
  }
})
