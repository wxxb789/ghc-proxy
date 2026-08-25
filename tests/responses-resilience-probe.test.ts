import { describe, expect, test } from 'bun:test'

import { classifyResult, createSkippedResult } from '../scripts/probes/responses-resilience'

const storeTrueProbe = {
  name: 'store_true',
  chain: 'store_behavior',
  expect: 'reject' as const,
  rejection: { statuses: [400], messageIncludes: 'store is not supported' },
  build: () => null,
}

describe('Responses resilience probe classification', () => {
  test('accepts only the expected store rejection', () => {
    expect(classifyResult(storeTrueProbe, 400, {
      error: { message: 'store is not supported' },
    }).status).toBe('expected_reject')
  })

  test('does not treat transient failures as store capability evidence', () => {
    expect(classifyResult(storeTrueProbe, 429, {
      error: { message: 'rate limited' },
    }).status).toBe('unexpected_reject')
    expect(classifyResult(storeTrueProbe, 503, {
      error: { message: 'provider overloaded' },
    }).status).toBe('unexpected_reject')
  })

  test('requires the expected rejection message', () => {
    expect(classifyResult(storeTrueProbe, 400, {
      error: { message: 'invalid request' },
    }).status).toBe('unexpected_reject')
  })

  test('keeps unexecuted cases distinct from passes', () => {
    expect(createSkippedResult(storeTrueProbe, 'model family not verified')).toMatchObject({
      status: 'skipped',
      note: 'model family not verified',
    })
  })
})
