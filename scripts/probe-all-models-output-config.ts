#!/usr/bin/env bun

/**
 * Probe ALL /v1/messages models for output_config acceptance.
 * Tests whether older models (without adaptive_thinking) reject output_config.
 *
 * Usage: bun run scripts/probe-all-models-output-config.ts
 */

import type { Model } from '~/types'

import process from 'node:process'
import consola from 'consola'
import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { readConfig } from '~/lib/config'
import { ensurePaths } from '~/lib/paths'
import { cacheModels, cacheVSCodeVersion, getClientConfig, state } from '~/lib/state'
import { setupCopilotToken, setupGitHubToken } from '~/lib/token'

const REQUEST_TIMEOUT_MS = 30_000

async function bootstrap() {
  consola.level = 0
  state.config.accountType = 'enterprise'
  state.config.manualApprove = false
  state.config.rateLimitWait = false
  state.config.showToken = false
  state.config.upstreamTimeoutSeconds = Math.floor(REQUEST_TIMEOUT_MS / 1000)

  await ensurePaths()
  await readConfig()
  await cacheVSCodeVersion()
  await setupGitHubToken()
  await setupCopilotToken()
  await cacheModels()
}

async function probe(_modelId: string, body: Record<string, unknown>): Promise<{
  httpStatus: number
  accepted: boolean
  error?: string
}> {
  const clientConfig = getClientConfig()
  const url = `${copilotBaseUrl(clientConfig)}/v1/messages`
  const headers = copilotHeaders(state.auth, clientConfig, { initiator: 'agent' })

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    parsed = text
  }

  const accepted = response.status >= 200 && response.status < 300
  const errorMsg = !accepted && typeof parsed === 'object' && parsed !== null
    ? (parsed as { error?: { message?: string } }).error?.message ?? text.slice(0, 200)
    : undefined

  return { httpStatus: response.status, accepted, error: errorMsg }
}

async function main() {
  await bootstrap()

  const models = state.cache.models?.data ?? []
  const messagesModels = models.filter((m: Model) => m.supported_endpoints?.includes('/v1/messages'))

  process.stdout.write(`\n=== Probing output_config acceptance across ALL /v1/messages models ===\n\n`)
  process.stdout.write(`Found ${messagesModels.length} models with /v1/messages support\n\n`)

  for (const model of messagesModels) {
    const hasAdaptive = model.capabilities.supports.adaptive_thinking ?? false
    process.stdout.write(`--- ${model.id} (adaptive_thinking=${hasAdaptive}) ---\n`)

    // Test 1: baseline
    const baseline = await probe(model.id, {
      model: model.id,
      max_tokens: 32,
      stream: false,
      messages: [{ role: 'user', content: 'Reply OK.' }],
    })
    process.stdout.write(`  baseline:                   ${baseline.accepted ? '✓' : '✗'} (${baseline.httpStatus})${baseline.error ? ` — ${baseline.error}` : ''}\n`)
    await Bun.sleep(300)

    // Test 2: output_config.effort = high
    const outputConfig = await probe(model.id, {
      model: model.id,
      max_tokens: 32,
      stream: false,
      messages: [{ role: 'user', content: 'Reply OK.' }],
      output_config: { effort: 'high' },
    })
    process.stdout.write(`  output_config.effort=high:  ${outputConfig.accepted ? '✓' : '✗'} (${outputConfig.httpStatus})${outputConfig.error ? ` — ${outputConfig.error}` : ''}\n`)
    await Bun.sleep(300)

    // Test 3: thinking:adaptive + output_config
    const adaptiveCombo = await probe(model.id, {
      model: model.id,
      max_tokens: 32,
      stream: false,
      messages: [{ role: 'user', content: 'Reply OK.' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    })
    process.stdout.write(`  adaptive + output_config:   ${adaptiveCombo.accepted ? '✓' : '✗'} (${adaptiveCombo.httpStatus})${adaptiveCombo.error ? ` — ${adaptiveCombo.error}` : ''}\n`)
    await Bun.sleep(300)

    // Test 4: thinking:adaptive alone
    const adaptiveAlone = await probe(model.id, {
      model: model.id,
      max_tokens: 32,
      stream: false,
      messages: [{ role: 'user', content: 'Reply OK.' }],
      thinking: { type: 'adaptive' },
    })
    process.stdout.write(`  thinking:adaptive alone:    ${adaptiveAlone.accepted ? '✓' : '✗'} (${adaptiveAlone.httpStatus})${adaptiveAlone.error ? ` — ${adaptiveAlone.error}` : ''}\n`)
    await Bun.sleep(300)

    process.stdout.write('\n')
  }
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  })
