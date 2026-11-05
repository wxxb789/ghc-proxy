import type { DashboardQuotaDetail } from '@contract'

/** State tones. `hollow` = neutral quiet with a hollow lamp; `none` = quiet, no lamp, muted text. */
export type Tone = 'ok' | 'warn' | 'bad' | 'info'
export type ToneKind = Tone | 'hollow' | 'none'

/**
 * Server value → tone whitelist (spec §4.3). `health` covers overview, GitHub,
 * Copilot, quota and metadata-refresh statuses: their vocabularies do not conflict.
 */
const TONES = {
  health: { ok: 'ok', degraded: 'warn', stale: 'warn', partial: 'warn', missing: 'bad', unavailable: 'bad', unknown: 'hollow', not_applicable: 'none' },
  request: { completed: 'ok', in_flight: 'info', streaming: 'info', aborted: 'warn', failed: 'bad' },
  deviceAuth: { succeeded: 'ok', pending: 'info', failed: 'bad' },
  availability: { ready: 'ok', unavailable: 'bad' },
  onboarding: { available: 'ok', unavailable: 'hollow' },
} satisfies Record<string, Record<string, ToneKind>>

export type ToneDomain = keyof typeof TONES

/** Unlisted values fall back to a neutral hollow lamp with the raw text. */
export function toneOf(domain: ToneDomain, value: string | undefined): ToneKind {
  const table: Record<string, ToneKind> = TONES[domain]
  return value !== undefined && Object.hasOwn(table, value) ? table[value]! : 'hollow'
}

/** Loud (tinted) tags are reserved for abnormal and in-progress values. */
export const isLoud = (tone: ToneKind): tone is 'warn' | 'bad' | 'info' => tone === 'warn' || tone === 'bad' || tone === 'info'

/** Displayed text: the server value with `_` replaced by a space, lowercase as sent. */
export function statusText(value: string | undefined): string {
  return value ? value.replaceAll('_', ' ') : 'unknown'
}

/** Single source for quota meters, the Status rail row and issue rules Q1/Q2 (spec §6.5). */
export function quotaTone(detail: DashboardQuotaDetail | undefined): 'ok' | 'warn' | 'bad' | null {
  if (!detail)
    return null
  if (detail.unlimited)
    return 'ok'
  if (detail.remaining === 0 && !detail.overagePermitted)
    return 'bad'
  const pct = detail.percentRemaining
  if (!Number.isFinite(pct))
    return null
  return pct <= 5 ? 'bad' : pct <= 20 ? 'warn' : 'ok'
}

/** HTTP status text tone: 1xx–3xx neutral, 4xx warn, 5xx bad, absent `null`. */
export function httpTone(status: number | undefined): 'neutral' | 'warn' | 'bad' | null {
  if (status === undefined)
    return null
  return status >= 500 ? 'bad' : status >= 400 ? 'warn' : 'neutral'
}
