/**
 * Shared output formatting for probe scripts.
 *
 * Consolidates the status-icon, per-probe-line, summary-count, and JSON
 * snapshot-envelope formatting that was duplicated across the probe scripts.
 */

import type { ProbeResult } from './probe-harness'

import process from 'node:process'

/**
 * Icon for a {@link ProbeResult} status.
 */
export function statusIcon(status: ProbeResult['status']): string {
  switch (status) {
    case 'accepted':
      return '✓'
    case 'rejected':
      return '✗'
    case 'error':
      return '!'
  }
}

/**
 * Format a single probe result as `<icon> <status> (<http>)[ — <error>]`.
 */
export function formatProbeLine(result: ProbeResult): string {
  const head = `${statusIcon(result.status)} ${result.status} (${result.httpStatus ?? 'n/a'})`
  return result.errorMessage ? `${head} — ${result.errorMessage}` : head
}

export interface ProbeCounts {
  accepted: number
  rejected: number
  error: number
}

/**
 * Tally probe results by status.
 */
export function summarizeProbeResults(results: Array<ProbeResult>): ProbeCounts {
  const counts: ProbeCounts = { accepted: 0, rejected: 0, error: 0 }
  for (const result of results) {
    counts[result.status]++
  }
  return counts
}

/**
 * Write a deterministic JSON snapshot to stdout, stamping `generatedAt`
 * first so the diffable header is stable across the rest of the payload.
 */
export function writeJsonSnapshot(payload: Record<string, unknown>): void {
  const stamped = { generatedAt: new Date().toISOString(), ...payload }
  process.stdout.write(`${JSON.stringify(stamped, null, 2)}\n`)
}

/**
 * Sorted key list of a Map. Uses forEach+push rather than spreading the
 * iterator so the lint auto-fixer cannot rewrite it to `.keys().toSorted()`
 * (an iterator helper absent from the configured TS lib).
 */
function sortedKeys(map: Map<string, unknown>): Array<string> {
  const keys: Array<string> = []
  map.forEach((_, key) => keys.push(key))
  keys.sort()
  return keys
}

/**
 * Convert a nested `Map<string, Map<string, V>>` into a record with both
 * key levels sorted, for diff-stable snapshot output.
 */
export function toSortedRecord<V>(
  map: Map<string, Map<string, V>>,
  transformLeaf: (value: V) => unknown = value => value,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const outerKey of sortedKeys(map)) {
    const inner = map.get(outerKey)!
    const innerRecord: Record<string, unknown> = {}
    for (const innerKey of sortedKeys(inner)) {
      innerRecord[innerKey] = transformLeaf(inner.get(innerKey)!)
    }
    out[outerKey] = innerRecord
  }
  return out
}
