#!/usr/bin/env bun

/**
 * Copilot tool support probe — tests all known tool types against every model.
 *
 * Outputs a deterministic JSON snapshot that can be diffed between weekly runs
 * to detect when Copilot adds or removes tool support.
 *
 * Usage:
 *   bun scripts/probes/copilot-tools.ts              # human-readable table
 *   bun scripts/probes/copilot-tools.ts --json        # JSON to stdout
 *   bun scripts/probes/copilot-tools.ts --model=claude-opus-4.6  # single model
 *
 * WARNING: Uses real Copilot quota — one request per (model × tool) pair.
 */

import type { Model } from '~/types'

import process from 'node:process'
import { MESSAGES_ENDPOINT, RESPONSES_ENDPOINT } from '~/lib/model-capabilities'
import { modelCache } from '~/state'

import { parseProbeArgs } from '../lib/probe-args'
import { bootstrapProbe, extractErrorMessage, pickMessagesModels, pickModelById, pickResponsesModels, runMain, sendRaw } from '../lib/probe-harness'
import { printBanner, toSortedRecord, writeJsonSnapshot } from '../lib/probe-report'

const REQUEST_TIMEOUT_MS = 60_000

// ── CLI args ──

const { jsonMode, requestedModelId } = parseProbeArgs()

// ── Tool case definitions ──

interface ToolCase {
  name: string
  tools: unknown[]
}

const messagesToolCases: ToolCase[] = [
  // Control
  {
    name: 'standard_function_tool',
    tools: [{
      name: 'echo',
      description: 'Echo back',
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    }],
  },
  // Type-based tools (from Copilot's supported tags list)
  {
    name: 'bash_20250124',
    tools: [{ type: 'bash_20250124', name: 'bash' }],
  },
  {
    name: 'text_editor_20250124',
    tools: [{ type: 'text_editor_20250124', name: 'str_replace_editor' }],
  },
  {
    name: 'text_editor_20250429',
    tools: [{ type: 'text_editor_20250429', name: 'str_replace_based_edit_tool' }],
  },
  {
    name: 'text_editor_20250728',
    tools: [{ type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' }],
  },
  {
    name: 'web_search_20250305',
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  },
  {
    name: 'web_search_20260209',
    tools: [{ type: 'web_search_20260209', name: 'web_search' }],
  },
  {
    name: 'web_fetch_20250910',
    tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }],
  },
  {
    name: 'web_fetch_20260209',
    tools: [{ type: 'web_fetch_20260209', name: 'web_fetch' }],
  },
  {
    name: 'memory_20250818',
    tools: [{ type: 'memory_20250818', name: 'memory' }],
  },
  {
    name: 'custom',
    tools: [{
      type: 'custom',
      name: 'my_custom_tool',
      description: 'A custom tool',
      input_schema: { type: 'object', properties: {} },
    }],
  },
  {
    name: 'tool_search_tool_bm25',
    tools: [{ type: 'tool_search_tool_bm25', name: 'tool_search_tool_bm25' }],
  },
  {
    name: 'tool_search_tool_bm25_20251119',
    tools: [{ type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' }],
  },
  {
    name: 'tool_search_tool_regex',
    tools: [{ type: 'tool_search_tool_regex', name: 'tool_search_tool_regex' }],
  },
  {
    name: 'tool_search_tool_regex_20251119',
    tools: [{ type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' }],
  },
  {
    name: 'mcp_toolset',
    tools: [{ type: 'mcp_toolset', name: 'mcp_toolset', server_label: 'test' }],
  },
  {
    name: 'mcp-client-2025-11-20',
    tools: [{ type: 'mcp-client-2025-11-20', name: 'mcp_client', server_label: 'test' }],
  },
  // Anthropic tools NOT in Copilot's tag list
  {
    name: 'code_execution_20250522',
    tools: [{ type: 'code_execution_20250522', name: 'code_execution' }],
  },
  {
    name: 'code_execution_20250825',
    tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
  },
  {
    name: 'code_execution_20260120',
    tools: [{ type: 'code_execution_20260120', name: 'code_execution' }],
  },
  {
    name: 'computer_20250124',
    tools: [{
      type: 'computer_20250124',
      name: 'computer',
      display_width_px: 1024,
      display_height_px: 768,
      display_number: 1,
    }],
  },
]

const responsesToolCases: ToolCase[] = [
  {
    name: 'function_tool',
    tools: [{
      type: 'function',
      name: 'echo',
      description: 'Echo back',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
    }],
  },
  { name: 'web_search_preview', tools: [{ type: 'web_search_preview' }] },
  { name: 'web_search_preview_2025_03_11', tools: [{ type: 'web_search_preview_2025_03_11' }] },
  { name: 'file_search', tools: [{ type: 'file_search' }] },
  { name: 'code_interpreter', tools: [{ type: 'code_interpreter' }] },
  {
    name: 'computer_use_preview',
    tools: [{ type: 'computer_use_preview', display_width: 1024, display_height: 768, environment: 'browser' }],
  },
  { name: 'image_generation', tools: [{ type: 'image_generation' }] },
  { name: 'custom_apply_patch', tools: [{ type: 'custom', name: 'apply_patch' }] },
  { name: 'custom_shell', tools: [{ type: 'custom', name: 'shell' }] },
  { name: 'mcp', tools: [{ type: 'mcp', server_label: 'test', headers: {} }] },
]

// ── Probe runner ──

interface ToolResult {
  status: 'supported' | 'rejected' | 'error'
  http: number
  error?: string
}

async function probeCase(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const { httpStatus, parsed } = await sendRaw(body, { endpoint, timeoutMs: REQUEST_TIMEOUT_MS })

    if (httpStatus >= 200 && httpStatus < 300)
      return { status: 'supported', http: httpStatus }

    return { status: 'rejected', http: httpStatus, error: extractErrorMessage(parsed) }
  }
  catch (err) {
    return { status: 'error', http: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

function buildMessagesBody(modelId: string, tools: unknown[]) {
  return {
    model: modelId,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    tools,
  }
}

function buildResponsesBody(modelId: string, tools: unknown[]) {
  return {
    model: modelId,
    input: [{ type: 'message', role: 'user', content: 'Reply with the single word OK.' }],
    max_output_tokens: 32,
    tools,
  }
}

// ── Model selection ──

function selectModels(models: Model[]) {
  const messagesModels = pickMessagesModels(models)
  const responsesModels = pickResponsesModels(models)

  if (requestedModelId) {
    const messages = pickModelById(messagesModels, requestedModelId)
    const responses = pickModelById(responsesModels, requestedModelId)
    return {
      messages: messages ? [messages] : [],
      responses: responses ? [responses] : [],
    }
  }

  return { messages: messagesModels, responses: responsesModels }
}

// ── Human-readable output ──

function printTable(
  endpoint: string,
  models: Model[],
  results: Map<string, Map<string, ToolResult>>,
) {
  if (models.length === 0) {
    process.stdout.write(`\n${endpoint}: no models available\n`)
    return
  }

  process.stdout.write(`\n── ${endpoint} ──\n\n`)

  for (const model of models) {
    const modelResults = results.get(model.id)
    if (!modelResults)
      continue

    process.stdout.write(`  ${model.id}\n`)

    for (const [toolName, result] of modelResults) {
      const pad = toolName.padEnd(38)
      if (result.status === 'supported') {
        process.stdout.write(`    ${pad} ✅ supported  (${result.http})\n`)
      }
      else if (result.status === 'rejected') {
        process.stdout.write(`    ${pad} ❌ rejected   (${result.http})\n`)
        process.stdout.write(`${''.padEnd(44)}→ ${result.error}\n`)
      }
      else {
        process.stdout.write(`    ${pad} ⚠️  error\n`)
        process.stdout.write(`${''.padEnd(44)}→ ${result.error}\n`)
      }
    }

    process.stdout.write('\n')
  }
}

// ── Main ──

async function runProbes(
  models: Model[],
  toolCases: ToolCase[],
  endpoint: string,
  buildBody: (modelId: string, tools: unknown[]) => Record<string, unknown>,
): Promise<Map<string, Map<string, ToolResult>>> {
  const results = new Map<string, Map<string, ToolResult>>()

  for (const model of models) {
    const modelMap = new Map<string, ToolResult>()
    if (!jsonMode)
      process.stdout.write(`\nProbing ${endpoint} × ${model.id} ...`)

    for (const tc of toolCases) {
      const result = await probeCase(endpoint, buildBody(model.id, tc.tools))
      modelMap.set(tc.name, result)
    }

    results.set(model.id, modelMap)
    if (!jsonMode)
      process.stdout.write(' done\n')
  }

  return results
}

function mapToSortedRecord(
  results: Map<string, Map<string, ToolResult>>,
): Record<string, Record<string, unknown>> {
  return toSortedRecord(results, r =>
    r.status === 'supported' ? { status: r.status, http: r.http } : r)
}

async function main() {
  await bootstrapProbe({ timeoutMs: REQUEST_TIMEOUT_MS })

  const allModels = modelCache.getModels()?.data ?? []
  const { messages: messagesModels, responses: responsesModels } = selectModels(allModels)

  const totalProbes
    = messagesModels.length * messagesToolCases.length
      + responsesModels.length * responsesToolCases.length

  if (!jsonMode) {
    printBanner('Copilot Backend — Tool Support Probe')
    process.stdout.write(`Models:  ${messagesModels.length} messages, ${responsesModels.length} responses\n`)
    process.stdout.write(`Probes:  ${totalProbes} total\n`)
  }

  const messagesResults = await runProbes(
    messagesModels,
    messagesToolCases,
    MESSAGES_ENDPOINT,
    buildMessagesBody,
  )
  const responsesResults = await runProbes(
    responsesModels,
    responsesToolCases,
    RESPONSES_ENDPOINT,
    buildResponsesBody,
  )

  if (jsonMode) {
    writeJsonSnapshot({
      models: {
        messages: messagesModels.map(m => m.id).sort(),
        responses: responsesModels.map(m => m.id).sort(),
      },
      messages: mapToSortedRecord(messagesResults),
      responses: mapToSortedRecord(responsesResults),
    })
  }
  else {
    printTable('/v1/messages', messagesModels, messagesResults)
    printTable('/responses', responsesModels, responsesResults)

    let supported = 0
    let rejected = 0
    let errors = 0
    for (const modelMap of [...messagesResults.values(), ...responsesResults.values()]) {
      for (const r of modelMap.values()) {
        if (r.status === 'supported')
          supported++
        else if (r.status === 'rejected')
          rejected++
        else errors++
      }
    }
    process.stdout.write(`── Summary: ${supported} supported, ${rejected} rejected, ${errors} errors (${totalProbes} total) ──\n`)
  }
}

runMain(main)
