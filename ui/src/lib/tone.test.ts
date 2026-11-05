import { describe, expect, it } from 'vitest'
import { httpTone, quotaTone, statusText, toneOf } from './tone.ts'

describe('toneOf whitelist (spec §4.3)', () => {
  it.each([
    ['health', 'ok', 'ok'],
    ['health', 'degraded', 'warn'],
    ['health', 'stale', 'warn'],
    ['health', 'partial', 'warn'],
    ['health', 'missing', 'bad'],
    ['health', 'unavailable', 'bad'],
    ['health', 'unknown', 'hollow'],
    ['health', 'not_applicable', 'none'],
    ['request', 'completed', 'ok'],
    ['request', 'in_flight', 'info'],
    ['request', 'streaming', 'info'],
    ['request', 'aborted', 'warn'],
    ['request', 'failed', 'bad'],
    ['deviceAuth', 'succeeded', 'ok'],
    ['deviceAuth', 'pending', 'info'],
    ['deviceAuth', 'failed', 'bad'],
    ['availability', 'ready', 'ok'],
    ['availability', 'unavailable', 'bad'],
    ['onboarding', 'available', 'ok'],
    ['onboarding', 'unavailable', 'hollow'],
  ] as const)('%s %s → %s', (domain, value, tone) => {
    expect(toneOf(domain, value)).toBe(tone)
  })

  it('falls back to neutral for unknown values, including prototype keys', () => {
    expect(toneOf('health', 'exploded')).toBe('hollow')
    expect(toneOf('request', 'constructor')).toBe('hollow')
    expect(toneOf('request', undefined)).toBe('hollow')
  })

  it('shows server values with underscores as spaces, lowercase as sent', () => {
    expect(statusText('not_applicable')).toBe('not applicable')
    expect(statusText('in_flight')).toBe('in flight')
  })
})

describe('quotaTone (spec §6.5)', () => {
  const detail = (percentRemaining: number, remaining = 10, overagePermitted = false, unlimited = false) =>
    ({ entitlement: 100, remaining, percentRemaining, unlimited, overagePermitted })

  it('maps thresholds', () => {
    expect(quotaTone(detail(0, 0, false, true))).toBe('ok')
    expect(quotaTone(detail(20.1))).toBe('ok')
    expect(quotaTone(detail(20))).toBe('warn')
    expect(quotaTone(detail(5.1))).toBe('warn')
    expect(quotaTone(detail(5))).toBe('bad')
    expect(quotaTone(detail(50, 0, false))).toBe('bad')
    expect(quotaTone(detail(Number.NaN))).toBeNull()
    expect(quotaTone(undefined)).toBeNull()
  })
})

describe('httpTone', () => {
  it('maps status classes', () => {
    expect(httpTone(204)).toBe('neutral')
    expect(httpTone(302)).toBe('neutral')
    expect(httpTone(404)).toBe('warn')
    expect(httpTone(502)).toBe('bad')
    expect(httpTone(undefined)).toBeNull()
  })
})
