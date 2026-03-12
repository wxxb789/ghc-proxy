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

import type { Model } from '~/types'

import process from 'node:process'
import consola from 'consola'
import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { readConfig } from '~/lib/config'
import { ensurePaths } from '~/lib/paths'
import { cacheModels, cacheVSCodeVersion, getClientConfig, state } from '~/lib/state'
import { setupCopilotToken, setupGitHubToken } from '~/lib/token'

const jsonMode = Bun.argv.includes('--json')
const REQUEST_TIMEOUT_MS = 30_000

interface ProbeResult {
  name: string
  extraFields: Record<string, unknown>
  status: 'accepted' | 'rejected' | 'error'
  httpStatus?: number
  errorMessage?: string
  note: string
}

// The base payload that is known to work
function basePayload(modelId: string) {
  return {
    model: modelId,
    max_tokens: 32,
    stream: false as const,
    messages: [{ role: 'user' as const, content: 'Reply with the single word OK.' }],
  }
}

// Each probe adds one or more extra fields on top of the base payload
function buildProbes(modelId: string): Array<{ name: string, body: Record<string, unknown> }> {
  return [
    // ── Control: baseline with no extras ──
    {
      name: 'baseline (no extras)',
      body: basePayload(modelId),
    },

    // ── output_config variants (Anthropic official) ──
    {
      name: 'output_config.effort = high',
      body: { ...basePayload(modelId), output_config: { effort: 'high' } },
    },
    {
      name: 'output_config.effort = low',
      body: { ...basePayload(modelId), output_config: { effort: 'low' } },
    },
    {
      name: 'output_config.effort = max',
      body: { ...basePayload(modelId), output_config: { effort: 'max' } },
    },

    // ── thinking + output_config combined ──
    {
      name: 'thinking:adaptive + output_config.effort=high',
      body: {
        ...basePayload(modelId),
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
      },
    },
    {
      name: 'thinking:adaptive (alone)',
      body: {
        ...basePayload(modelId),
        thinking: { type: 'adaptive' },
      },
    },
    {
      name: 'thinking:disabled (alone)',
      body: {
        ...basePayload(modelId),
        thinking: { type: 'disabled' },
      },
    },
    {
      name: 'thinking:disabled + output_config.effort=high',
      body: {
        ...basePayload(modelId),
        thinking: { type: 'disabled' },
        output_config: { effort: 'high' },
      },
    },

    // ── reasoning_effort (OpenAI Chat Completions style, top-level string) ──
    {
      name: 'reasoning_effort = high (Chat Completions style)',
      body: { ...basePayload(modelId), reasoning_effort: 'high' },
    },
    {
      name: 'reasoning_effort = low (Chat Completions style)',
      body: { ...basePayload(modelId), reasoning_effort: 'low' },
    },
    {
      name: 'reasoning_effort = medium (Chat Completions style)',
      body: { ...basePayload(modelId), reasoning_effort: 'medium' },
    },

    // ── reasoning (Responses API style, nested object) ──
    {
      name: 'reasoning.effort = high (Responses style)',
      body: { ...basePayload(modelId), reasoning: { effort: 'high' } },
    },

    // ── thinking:enabled with budget ──
    {
      name: 'thinking:enabled + budget_tokens=1024',
      body: {
        ...basePayload(modelId),
        thinking: { type: 'enabled', budget_tokens: 1024 },
      },
    },

    // ── thinking:adaptive + reasoning_effort (mixing both styles) ──
    {
      name: 'thinking:adaptive + reasoning_effort=high',
      body: {
        ...basePayload(modelId),
        thinking: { type: 'adaptive' },
        reasoning_effort: 'high',
      },
    },

    // ── thinking:adaptive + reasoning_effort + NO output_config ──
    {
      name: 'thinking:adaptive + reasoning_effort=low',
      body: {
        ...basePayload(modelId),
        thinking: { type: 'adaptive' },
        reasoning_effort: 'low',
      },
    },

    // ── Bogus field to confirm strict validation ──
    {
      name: 'bogus_field (confirm strict validation)',
      body: { ...basePayload(modelId), bogus_field_xyz: true },
    },
  ]
}

async function bootstrap() {
  if (jsonMode) {
    consola.level = Number.NEGATIVE_INFINITY
  }
  else {
    consola.level = 0
  }
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

function pickMessagesModel(models: Array<Model>): Model | undefined {
  return models.find(model => model.supported_endpoints?.includes('/v1/messages'))
}

async function runProbe(
  probe: { name: string, body: Record<string, unknown> },
): Promise<ProbeResult> {
  const { name, body } = probe
  const base = basePayload(body.model as string)
  const extraFields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (!(key in base)) {
      extraFields[key] = value
    }
  }

  try {
    const clientConfig = getClientConfig()
    const url = `${copilotBaseUrl(clientConfig)}/v1/messages`
    const headers = copilotHeaders(state.auth, clientConfig, {
      initiator: 'agent',
    })

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    const responseText = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(responseText)
    }
    catch {
      parsed = responseText
    }

    if (response.status >= 200 && response.status < 300) {
      return {
        name,
        extraFields,
        status: 'accepted',
        httpStatus: response.status,
        note: summarize(parsed),
      }
    }

    const errorMsg = extractErrorMessage(parsed)
    return {
      name,
      extraFields,
      status: 'rejected',
      httpStatus: response.status,
      errorMessage: errorMsg,
      note: errorMsg,
    }
  }
  catch (error) {
    return {
      name,
      extraFields,
      status: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
      note: error instanceof Error ? error.message : String(error),
    }
  }
}

function extractErrorMessage(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const err = (payload as { error?: { message?: string } }).error?.message
    if (err)
      return err
  }
  if (typeof payload === 'string')
    return payload.slice(0, 300)
  return JSON.stringify(payload).slice(0, 300)
}

function summarize(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as Record<string, unknown>
    if (p.type === 'message' && p.stop_reason) {
      return `stop_reason=${p.stop_reason}`
    }
  }
  return JSON.stringify(payload).slice(0, 200)
}

async function main() {
  await bootstrap()

  const models = state.cache.models?.data ?? []
  const model = pickMessagesModel(models)
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
  const results: Array<ProbeResult> = []

  for (const probe of probes) {
    if (!jsonMode) {
      process.stdout.write(`  Probing: ${probe.name} ... `)
    }

    const result = await runProbe(probe)
    results.push(result)

    if (!jsonMode) {
      const icon = result.status === 'accepted' ? '✓' : result.status === 'rejected' ? '✗' : '!'
      process.stdout.write(`${icon} ${result.status} (${result.httpStatus ?? 'n/a'})`)
      if (result.errorMessage) {
        process.stdout.write(` — ${result.errorMessage}`)
      }
      process.stdout.write('\n')
    }

    // Small delay between requests to avoid rate-limiting
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
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  })
