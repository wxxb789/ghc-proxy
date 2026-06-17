#!/usr/bin/env bun

/**
 * Probe script: verify Copilot /responses resilience against edge-case inputs.
 *
 * Covers evidence chains from the 404/400 investigation:
 *   1. encrypted_content round-trip (real blob obtained from upstream)
 *   2. item_reference with fake IDs (expected: 404)
 *   3. Scale testing — large item counts (reasoning + function_call pairs)
 *   4. store=true vs store=false behavior
 *   5. phase field on input messages
 *   6. orphaned function_call_output (no matching function_call)
 *
 * Usage:
 *   bun scripts/probes/responses-resilience.ts                # human-readable
 *   bun scripts/probes/responses-resilience.ts --json         # JSON to stdout
 *   bun scripts/probes/responses-resilience.ts --model=gpt-5.4  # specific model
 *
 * WARNING: Uses real Copilot quota — one request per probe case.
 */

import type { ResponsesResult } from '~/types'

import process from 'node:process'
import { RESPONSES_ENDPOINT } from '~/lib/model-capabilities'
import { modelCache } from '~/state'

import { parseProbeArgs } from '../lib/probe-args'
import { bootstrapProbe, extractErrorMessage, pickFirstResponsesModel, pickModelById, pickResponsesModels, runMain, sendRaw } from '../lib/probe-harness'
import { writeJsonSnapshot } from '../lib/probe-report'

const REQUEST_TIMEOUT_MS = 60_000

const { jsonMode, requestedModelId } = parseProbeArgs()

// ── Types ──

interface ProbeCase {
  name: string
  /** Evidence chain this probe verifies */
  chain: string
  /** Expected outcome: 'pass' = 2xx, 'reject' = 4xx (expected rejection) */
  expect: 'pass' | 'reject'
  build: (modelId: string, context: ProbeContext) => Record<string, unknown> | null
}

interface ProbeContext {
  /** Real encrypted_content blob from a prior reasoning request */
  encryptedContent?: string
  /** Real reasoning item ID from a prior request */
  reasoningItemId?: string
}

interface ProbeResult {
  name: string
  chain: string
  expect: 'pass' | 'reject'
  status: 'pass' | 'expected_reject' | 'unexpected_reject' | 'unexpected_pass' | 'error'
  httpStatus?: number
  note: string
}

// ── Probe cases ──

function simpleInput(text = 'Reply with OK.'): Array<Record<string, unknown>> {
  return [{ type: 'message', role: 'user', content: text }]
}

function makeFunctionCallPairs(count: number): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = []
  for (let i = 0; i < count; i++) {
    items.push({
      type: 'function_call',
      call_id: `call_probe_${i}`,
      name: 'echo',
      arguments: JSON.stringify({ value: `probe_${i}` }),
      status: 'completed',
    })
    items.push({
      type: 'function_call_output',
      call_id: `call_probe_${i}`,
      output: `result_${i}`,
    })
  }
  return items
}

const cases: ProbeCase[] = [
  // Chain 1: baseline
  {
    name: 'baseline',
    chain: 'baseline',
    expect: 'pass',
    build: modelId => ({
      model: modelId,
      input: simpleInput(),
      max_output_tokens: 32,
      store: false,
    }),
  },

  // Chain 2: store=true (Copilot should accept; returned IDs may be opaque)
  {
    name: 'store_true',
    chain: 'store_behavior',
    expect: 'pass',
    build: modelId => ({
      model: modelId,
      input: simpleInput(),
      max_output_tokens: 32,
      store: true,
    }),
  },

  // Chain 3: store=false explicit
  {
    name: 'store_false',
    chain: 'store_behavior',
    expect: 'pass',
    build: modelId => ({
      model: modelId,
      input: simpleInput(),
      max_output_tokens: 32,
      store: false,
    }),
  },

  // Chain 4: item_reference with fake ID → expected 404
  {
    name: 'item_reference_fake_id',
    chain: 'item_reference',
    expect: 'reject',
    build: modelId => ({
      model: modelId,
      input: [
        { type: 'item_reference', id: 'msg_fake_nonexistent_id_12345' },
        ...simpleInput(),
      ],
      max_output_tokens: 32,
      store: false,
    }),
  },

  // Chain 5: encrypted_content round-trip (requires context from prior request)
  {
    name: 'encrypted_content_roundtrip',
    chain: 'encrypted_content',
    expect: 'pass',
    build: (modelId, ctx) => {
      if (!ctx.encryptedContent || !ctx.reasoningItemId) {
        return null // skip — no encrypted_content obtained
      }
      return {
        model: modelId,
        input: [
          {
            type: 'reasoning',
            id: ctx.reasoningItemId,
            encrypted_content: ctx.encryptedContent,
            summary: [{ type: 'summary_text', text: 'Prior reasoning.' }],
          },
          ...simpleInput('Continue from prior reasoning. Reply OK.'),
        ],
        max_output_tokens: 32,
        store: false,
        include: ['reasoning.encrypted_content'],
      }
    },
  },

  // Chain 6: fake encrypted_content → expected 400
  {
    name: 'encrypted_content_fake',
    chain: 'encrypted_content',
    expect: 'reject',
    build: modelId => ({
      model: modelId,
      input: [
        {
          type: 'reasoning',
          id: 'rs_fake_id',
          encrypted_content: 'AAAA_fake_encrypted_content_blob_not_real',
          summary: [{ type: 'summary_text', text: 'Fake reasoning.' }],
        },
        ...simpleInput(),
      ],
      max_output_tokens: 32,
      store: false,
    }),
  },

  // Chain 7: scale — many function_call pairs
  {
    name: 'scale_50_fc_pairs',
    chain: 'scale',
    expect: 'pass',
    build: modelId => ({
      model: modelId,
      input: [
        ...simpleInput('You called 50 functions. Now reply OK.'),
        ...makeFunctionCallPairs(50),
      ],
      max_output_tokens: 32,
      store: false,
    }),
  },

  // Chain 8: orphaned function_call_output (no matching function_call)
  {
    name: 'orphaned_function_call_output',
    chain: 'orphaned_output',
    expect: 'reject',
    build: modelId => ({
      model: modelId,
      input: [
        ...simpleInput(),
        {
          type: 'function_call_output',
          call_id: 'call_orphan_no_match',
          output: 'orphaned result',
        },
      ],
      max_output_tokens: 32,
      store: false,
    }),
  },

  // Chain 9: phase field on input message
  {
    name: 'phase_on_input_message',
    chain: 'phase_field',
    expect: 'pass',
    build: modelId => ({
      model: modelId,
      input: [{
        type: 'message',
        role: 'assistant',
        content: 'Prior assistant message.',
        phase: 'commentary',
      }, ...simpleInput()],
      max_output_tokens: 32,
      store: false,
    }),
  },
]

// ── Probe runner ──

async function sendProbe(
  body: Record<string, unknown>,
): Promise<{ httpStatus: number, payload: unknown }> {
  const { httpStatus, parsed } = await sendRaw(body, {
    endpoint: RESPONSES_ENDPOINT,
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  return { httpStatus, payload: parsed }
}

function classifyResult(probe: ProbeCase, httpStatus: number, payload: unknown): ProbeResult {
  const is2xx = httpStatus >= 200 && httpStatus < 300
  const note = is2xx
    ? summarizeSuccess(payload)
    : `${httpStatus} ${extractErrorMessage(payload)}`

  if (probe.expect === 'pass') {
    return {
      name: probe.name,
      chain: probe.chain,
      expect: probe.expect,
      status: is2xx ? 'pass' : 'unexpected_reject',
      httpStatus,
      note,
    }
  }

  // expect === 'reject'
  return {
    name: probe.name,
    chain: probe.chain,
    expect: probe.expect,
    status: is2xx ? 'unexpected_pass' : 'expected_reject',
    httpStatus,
    note,
  }
}

function summarizeSuccess(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as Record<string, unknown>
    if (p.object === 'response' && Array.isArray(p.output)) {
      const types = (p.output as Array<{ type?: string }>).map(i => i.type).join(', ')
      return `status=${p.status}; output=[${types}]`
    }
  }
  return JSON.stringify(payload).slice(0, 200)
}

// ── Obtain real encrypted_content ──

async function obtainEncryptedContent(
  modelId: string,
): Promise<ProbeContext> {
  if (!jsonMode) {
    process.stdout.write('  Obtaining real encrypted_content for round-trip test...')
  }

  try {
    const { httpStatus, payload } = await sendProbe({
      model: modelId,
      input: simpleInput('What is 2+2? Think step by step.'),
      reasoning: { effort: 'medium', summary: 'detailed' },
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 256,
      store: false,
    })

    if (httpStatus < 200 || httpStatus >= 300) {
      if (!jsonMode)
        process.stdout.write(` failed (${httpStatus})\n`)
      return {}
    }

    const result = payload as ResponsesResult
    const reasoningItem = result.output?.find(
      (item: { type?: string }) => item.type === 'reasoning',
    ) as Record<string, unknown> | undefined

    const ec = reasoningItem?.encrypted_content
    const id = reasoningItem?.id

    if (typeof ec === 'string' && typeof id === 'string') {
      if (!jsonMode)
        process.stdout.write(` ok (${ec.length} chars)\n`)
      return { encryptedContent: ec, reasoningItemId: id }
    }

    if (!jsonMode)
      process.stdout.write(' no encrypted_content in response\n')
    return {}
  }
  catch (err) {
    if (!jsonMode)
      process.stdout.write(` error: ${err}\n`)
    return {}
  }
}

// ── Main ──

async function main() {
  await bootstrapProbe({ silent: jsonMode, timeoutMs: REQUEST_TIMEOUT_MS })

  const allModels = modelCache.getModels()?.data ?? []
  const responsesModels = pickResponsesModels(allModels)
  const selectedModel = requestedModelId
    ? pickModelById(responsesModels, requestedModelId)
    : pickFirstResponsesModel(allModels)

  if (!selectedModel) {
    process.stderr.write(`No /responses model found${requestedModelId ? ` matching ${requestedModelId}` : ''}.\n`)
    process.exit(1)
  }

  if (!jsonMode) {
    process.stdout.write('╔══════════════════════════════════════════════════════════════╗\n')
    process.stdout.write('║    /responses Resilience Probe                              ║\n')
    process.stdout.write('╚══════════════════════════════════════════════════════════════╝\n\n')
    process.stdout.write(`Model: ${selectedModel.id}\n`)
    process.stdout.write(`Cases: ${cases.length}\n\n`)
  }

  // Obtain real encrypted_content for round-trip test
  const context = await obtainEncryptedContent(selectedModel.id)

  const results: ProbeResult[] = []

  for (const probe of cases) {
    const body = probe.build(selectedModel.id, context)

    if (!body) {
      results.push({
        name: probe.name,
        chain: probe.chain,
        expect: probe.expect,
        status: 'pass',
        note: 'skipped — prerequisite not available',
      })
      if (!jsonMode) {
        process.stdout.write(`  ${probe.name.padEnd(36)} ⏭  skipped (no prerequisite)\n`)
      }
      continue
    }

    try {
      if (!jsonMode) {
        process.stdout.write(`  ${probe.name.padEnd(36)} `)
      }

      const { httpStatus, payload } = await sendProbe(body)
      const result = classifyResult(probe, httpStatus, payload)
      results.push(result)

      if (!jsonMode) {
        const icon = result.status === 'pass'
          ? '✅'
          : result.status === 'expected_reject'
            ? '✅'
            : result.status === 'unexpected_reject'
              ? '❌'
              : result.status === 'unexpected_pass'
                ? '⚠️'
                : '💥'
        process.stdout.write(`${icon} ${result.status} (${httpStatus}) ${result.note}\n`)
      }
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        name: probe.name,
        chain: probe.chain,
        expect: probe.expect,
        status: 'error',
        note: msg,
      })
      if (!jsonMode) {
        process.stdout.write(`💥 error: ${msg}\n`)
      }
    }
  }

  // Summary
  if (jsonMode) {
    writeJsonSnapshot({
      model: selectedModel.id,
      context: {
        hasEncryptedContent: !!context.encryptedContent,
      },
      results,
    })
  }
  else {
    const passed = results.filter(r => r.status === 'pass' || r.status === 'expected_reject')
    const failed = results.filter(r => r.status === 'unexpected_reject' || r.status === 'unexpected_pass' || r.status === 'error')

    process.stdout.write(`\n── Summary: ${passed.length} ok, ${failed.length} failed (${results.length} total) ──\n`)

    if (failed.length > 0) {
      process.stdout.write('\nFailed cases:\n')
      for (const r of failed) {
        process.stdout.write(`  ❌ ${r.name} [${r.chain}]: ${r.status} — ${r.note}\n`)
      }
    }
  }
}

runMain(main)
