#!/usr/bin/env bun

/**
 * Tool support catalogue for both boundaries.
 *
 * Answers the question a capability table actually needs — *does the tool
 * work* — rather than the question that is easy to ask, "does upstream return
 * 200 when I mention it". Those differ, and conflating them is what put a
 * bogus `web_search` block in the Responses handler for months
 * (`docs/solutions/conventions/capability-verdicts-are-scoped-to-one-boundary.md`).
 *
 * Two levels per (model × tool):
 *   1. ACCEPT   — declare the tool, ask for one word. Records the HTTP status.
 *   2. FUNCTION — ask something that *requires* the tool, then look in the
 *                 response for proof it ran. Only runs when level 1 accepted.
 *
 * Proof depends on who executes the tool:
 *   server — upstream runs it; expect a result item/block back
 *   client — the model emits a call for the caller to run; expect that call
 *
 * A tool that accepts but never appears in the output is reported `silent`,
 * which is its own finding: upstream tolerates the field and does nothing.
 *
 * Usage:
 *   bun scripts/probes/tool-support.ts                      # both boundaries
 *   bun scripts/probes/tool-support.ts --json               # JSON snapshot
 *   bun scripts/probes/tool-support.ts --model=claude-opus-5
 *   bun scripts/probes/tool-support.ts --boundary=responses  # or: messages
 *   bun scripts/probes/tool-support.ts --accept-only        # skip level 2 (cheap)
 *   bun scripts/probes/tool-support.ts --names              # name-filter cases too
 *
 * WARNING: uses real Copilot quota, up to two requests per (model × tool).
 * Sequential by design — the upstream is shared and rate-limited.
 */

import type { ToolCase } from '../lib/tool-cases'
import type { Model } from '~/types'

import process from 'node:process'
import { MESSAGES_ENDPOINT, modelCache, RESPONSES_ENDPOINT } from '~/state'

import { getFlagValue, hasFlag, parseProbeArgs } from '../lib/probe-args'
import {
  bootstrapProbe,
  extractErrorMessage,
  isUnmeasuredStatus,
  pickMessagesModels,
  pickResponsesModels,
  runMain,
  sendRawWithRetry,
} from '../lib/probe-harness'
import { printBanner, writeJsonSnapshot } from '../lib/probe-report'
import {
  anthropicFunctionTool,
  MESSAGES_TOOL_CASES,
  nameFilterCases,
  RESPONSES_TOOL_CASES,
  responsesFunctionTool,
} from '../lib/tool-cases'

const REQUEST_TIMEOUT_MS = 120_000

const { jsonMode, requestedModelId } = parseProbeArgs()
const acceptOnly = hasFlag('--accept-only')
const withNames = hasFlag('--names')
const boundaryFilter = getFlagValue('--boundary')

// ── Verdict ──

type Accept = 'accepted' | 'rejected' | 'unmeasured' | 'error'
type Functional = 'ran' | 'called' | 'silent' | 'rejected' | 'unmeasured' | 'error' | 'skipped'

interface Verdict {
  /** Did upstream accept the tool declaration? */
  accept: Accept
  acceptHttp: number
  acceptError?: string
  /** Did the tool actually do anything? Absent when `--accept-only`. */
  functional?: Functional
  /** Output item / content-block types seen in the functional run. */
  observed?: Array<string>
  functionalError?: string
  /** One-line supporting quote from the model's own text. */
  evidence?: string
}

/**
 * Collapse a verdict to the single word a capability table should print.
 *
 * `ran`/`called` are the only two that mean supported. `silent` is a distinct
 * negative — the field is tolerated but inert — and must not read as either
 * support or rejection. `unmeasured` (capacity blip) and `error` (transport
 * failure) are both absence of evidence and must never read as support;
 * `rejected` is a real negative verdict upstream gave firmly.
 */
export function summarize(v: Verdict): string {
  if (v.accept === 'unmeasured')
    return 'unmeasured'
  if (v.accept === 'error')
    return 'error'
  if (v.accept === 'rejected')
    return 'unsupported'
  if (!v.functional || v.functional === 'skipped')
    return 'accepted'
  if (v.functional === 'unmeasured')
    return 'unmeasured'
  if (v.functional === 'error')
    return 'error'
  if (v.functional === 'rejected')
    return 'unsupported'
  return v.functional === 'silent' ? 'inert' : 'supported'
}

// ── Response shape readers ──

/** `/responses`: the tool's trace lives in `output[].type`. */
function readResponses(parsed: unknown) {
  const p = parsed as { status?: string, output?: Array<Record<string, unknown>> } | null
  const types: Array<string> = []
  const names: Array<string> = []
  let text = ''
  for (const item of p?.output ?? []) {
    if (typeof item.type === 'string')
      types.push(item.type)
    if (typeof item.name === 'string')
      names.push(item.name)
    for (const c of (item.content as Array<{ text?: string }> | undefined) ?? []) {
      if (typeof c.text === 'string')
        text += c.text
    }
  }
  return { types, names, text }
}

/** `/v1/messages`: the trace lives in `content[].type`. */
function readMessages(parsed: unknown) {
  const p = parsed as { content?: Array<Record<string, unknown>> } | null
  const types: Array<string> = []
  const names: Array<string> = []
  let text = ''
  for (const block of p?.content ?? []) {
    if (typeof block.type === 'string')
      types.push(block.type)
    if (typeof block.name === 'string')
      names.push(block.name)
    if (typeof block.text === 'string')
      text += block.text
  }
  return { types, names, text }
}

/**
 * Did the tool leave a trace?
 *
 * Requires both the expected item type AND, when the case names one, the
 * expected tool name — otherwise a model that invents an unrelated tool call
 * would score as a hit.
 */
function classify(kase: ToolCase, types: Array<string>, names: Array<string>): Functional {
  const traced = kase.proof.some(p => types.includes(p))
  if (!traced)
    return 'silent'
  if (kase.callName && names.length > 0 && !names.includes(kase.callName))
    return 'silent'
  return kase.kind === 'server' ? 'ran' : 'called'
}

// ── Probing ──

interface Boundary {
  /** Display name, and the snapshot key. */
  name: string
  /**
   * Value accepted by `--boundary`.
   *
   * Deliberately not the endpoint path: Git Bash on Windows rewrites a bare
   * `/responses` argument into `C:/Program Files/Git/responses`, so a
   * path-shaped flag value is unusable on the platform this repo is developed
   * on.
   */
  slug: string
  endpoint: string
  cases: Array<ToolCase>
  models: Array<Model>
  /** Minimal request that declares `tools` and asks for one word. */
  accept: (modelId: string, tools: Array<unknown>) => Record<string, unknown>
  /** Request that should force the tool to be used. */
  exercise: (modelId: string, tools: Array<unknown>, prompt: string) => Record<string, unknown>
  read: (parsed: unknown) => { types: Array<string>, names: Array<string>, text: string }
}

async function probeCase(boundary: Boundary, modelId: string, kase: ToolCase): Promise<Verdict> {
  try {
    return await probeCaseInner(boundary, modelId, kase)
  }
  catch (error) {
    // A transport failure — an expired `AbortSignal`, a reset connection — says
    // nothing about capability, and this matrix is quota-expensive. Record the
    // cell and keep going rather than letting one rejected fetch discard every
    // remaining measurement.
    return {
      accept: 'error',
      acceptHttp: 0,
      acceptError: error instanceof Error ? error.message : String(error),
    }
  }
}

async function probeCaseInner(boundary: Boundary, modelId: string, kase: ToolCase): Promise<Verdict> {
  const accept = await sendRawWithRetry(
    boundary.accept(modelId, [kase.tool]),
    { endpoint: boundary.endpoint, timeoutMs: REQUEST_TIMEOUT_MS },
  )

  if (isUnmeasuredStatus(accept.httpStatus)) {
    return {
      accept: 'unmeasured',
      acceptHttp: accept.httpStatus,
      acceptError: extractErrorMessage(accept.parsed),
    }
  }
  if (accept.httpStatus < 200 || accept.httpStatus >= 300) {
    return {
      accept: 'rejected',
      acceptHttp: accept.httpStatus,
      acceptError: extractErrorMessage(accept.parsed),
    }
  }

  const verdict: Verdict = { accept: 'accepted', acceptHttp: accept.httpStatus }
  if (acceptOnly) {
    verdict.functional = 'skipped'
    return verdict
  }

  const run = await sendRawWithRetry(
    boundary.exercise(modelId, [kase.tool], kase.prompt),
    { endpoint: boundary.endpoint, timeoutMs: REQUEST_TIMEOUT_MS },
  )

  // Same split the accept phase makes above: a capacity blip is no verdict, but
  // a deterministic 4xx is a stable negative one. Folding both into
  // `unmeasured` would report "no verdict, rerun it" for a result upstream
  // already gave firmly.
  if (isUnmeasuredStatus(run.httpStatus)) {
    verdict.functional = 'unmeasured'
    verdict.functionalError = extractErrorMessage(run.parsed)
    return verdict
  }
  if (run.httpStatus < 200 || run.httpStatus >= 300) {
    verdict.functional = 'rejected'
    verdict.functionalError = extractErrorMessage(run.parsed)
    return verdict
  }

  const { types, names, text } = boundary.read(run.parsed)
  verdict.observed = types
  verdict.functional = classify(kase, types, names)
  verdict.evidence = text.slice(0, 160)
  return verdict
}

// ── Boundaries ──

function buildBoundaries(models: Array<Model>): Array<Boundary> {
  return [
    {
      name: '/responses',
      slug: 'responses',
      endpoint: RESPONSES_ENDPOINT,
      cases: withNames
        ? [...RESPONSES_TOOL_CASES, ...nameFilterCases(responsesFunctionTool, ['function_call'])]
        : RESPONSES_TOOL_CASES,
      models: pickResponsesModels(models),
      accept: (model, tools) => ({
        model,
        input: [{ type: 'message', role: 'user', content: 'Reply with the single word OK.' }],
        max_output_tokens: 32,
        tools,
        store: false,
      }),
      exercise: (model, tools, prompt) => ({
        model,
        input: [{ type: 'message', role: 'user', content: prompt }],
        max_output_tokens: 2048,
        tools,
        tool_choice: 'auto',
        store: false,
      }),
      read: readResponses,
    },
    {
      name: '/v1/messages',
      slug: 'messages',
      endpoint: MESSAGES_ENDPOINT,
      cases: withNames
        ? [...MESSAGES_TOOL_CASES, ...nameFilterCases(anthropicFunctionTool, ['tool_use'])]
        : MESSAGES_TOOL_CASES,
      models: pickMessagesModels(models),
      accept: (model, tools) => ({
        model,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        tools,
      }),
      exercise: (model, tools, prompt) => ({
        model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
        tools,
      }),
      read: readMessages,
    },
  ]
}

// ── Output ──

const ICON: Record<string, string> = {
  supported: '✅',
  accepted: '☑️ ',
  inert: '💤',
  unsupported: '❌',
  unmeasured: '❓',
}

function printModel(modelId: string, verdicts: Record<string, Verdict>): void {
  process.stdout.write(`\n  ${modelId}\n`)
  for (const [name, v] of Object.entries(verdicts)) {
    const label = summarize(v)
    process.stdout.write(`    ${ICON[label] ?? ' '} ${name.padEnd(34)} ${label}\n`)
    if (v.acceptError) {
      process.stdout.write(`${''.padEnd(41)}→ ${v.acceptError}\n`)
    }
    else if (label === 'inert') {
      process.stdout.write(`${''.padEnd(41)}→ accepted but never invoked; saw [${(v.observed ?? []).join(',')}]\n`)
    }
  }
}

runMain(async () => {
  await bootstrapProbe({ silent: jsonMode, timeoutMs: REQUEST_TIMEOUT_MS })

  const all = modelCache.getModels()?.data ?? []
  const allBoundaries = buildBoundaries(all)

  if (boundaryFilter && !allBoundaries.some(b => b.slug === boundaryFilter)) {
    throw new Error(
      `unknown --boundary=${boundaryFilter}; expected one of ${allBoundaries.map(b => b.slug).join(', ')}`,
    )
  }

  const boundaries = allBoundaries
    .filter(b => !boundaryFilter || b.slug === boundaryFilter)
    .map(b => ({
      ...b,
      models: requestedModelId ? b.models.filter(m => m.id === requestedModelId) : b.models,
    }))

  const total = boundaries.reduce((n, b) => n + b.models.length * b.cases.length, 0)

  // A probe that silently measures nothing is worse than one that fails: the
  // empty output reads like "no tools supported" rather than "you typo'd a flag".
  if (total === 0) {
    throw new Error(
      requestedModelId
        ? `no cells to probe — is --model=${requestedModelId} a live model on the selected boundary?`
        : 'no cells to probe — the model cache returned nothing for the selected boundary',
    )
  }

  if (!jsonMode) {
    printBanner('Copilot — Tool Support')
    process.stdout.write(`${total} tool cell(s), up to ${acceptOnly ? total : total * 2} requests\n`)
  }

  const snapshot: Record<string, Record<string, Record<string, Verdict>>> = {}
  const holes: Array<string> = []

  for (const boundary of boundaries) {
    snapshot[boundary.name] = {}
    if (!jsonMode && boundary.models.length > 0) {
      process.stdout.write(`\n── ${boundary.name} ──\n`)
    }

    for (const model of boundary.models) {
      const verdicts: Record<string, Verdict> = {}
      for (const kase of boundary.cases) {
        const verdict = await probeCase(boundary, model.id, kase)
        verdicts[kase.name] = verdict
        // Both mean the cell produced no verdict — a capacity blip or a
        // transport failure — so both belong in the rerun list.
        const summary = summarize(verdict)
        if (summary === 'unmeasured' || summary === 'error') {
          holes.push(`${boundary.name} ${model.id} × ${kase.name} (${verdict.acceptHttp})`)
        }
      }
      snapshot[boundary.name][model.id] = verdicts
      if (!jsonMode) {
        printModel(model.id, verdicts)
      }
    }
  }

  if (jsonMode) {
    writeJsonSnapshot({ probe: 'tool-support', acceptOnly, boundaries: snapshot })
    return
  }

  if (holes.length > 0) {
    process.stdout.write(`\n⚠  ${holes.length} cell(s) produced NO verdict — do not record these as unsupported:\n`)
    for (const hole of holes) {
      process.stdout.write(`     ${hole}\n`)
    }
    process.stdout.write('   Re-run before publishing a capability table.\n')
  }
})
