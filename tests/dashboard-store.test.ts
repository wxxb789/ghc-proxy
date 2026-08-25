import { describe, expect, test } from 'bun:test'

import {
  classifyObservedEndpoint,
  RECENT_REQUEST_LIMIT,
  RequestActivityStore,
  sanitizeObservedError,
} from '~/observability/request-store'

describe('RequestActivityStore', () => {
  test('tracks active metadata and moves completed requests into the recent ring', () => {
    let now = 1_000
    const store = new RequestActivityStore(() => now)

    store.start({
      requestId: 'req-1',
      method: 'POST',
      endpoint: '/v1/messages',
      requestedModel: 'claude-sonnet-5',
    })
    store.recordModelMapping('req-1', {
      originalModel: 'claude-sonnet-5',
      steps: [{
        tag: 'COMPACT',
        from: 'claude-sonnet-5',
        to: 'claude-haiku-4.5',
      }],
    })
    store.recordStrategy('req-1', 'native-messages')
    store.markStreaming('req-1')

    now = 1_025
    expect(store.snapshot()).toMatchObject({
      active: [{
        requestId: 'req-1',
        endpoint: '/v1/messages',
        state: 'streaming',
        durationMs: 25,
        requestedModel: 'claude-sonnet-5',
        effectiveModel: 'claude-haiku-4.5',
        selectedStrategy: 'native-messages',
        effects: [{ id: 'model.compact_route', count: 1 }],
      }],
      recent: [],
    })

    now = 1_040
    store.complete('req-1', 200)

    expect(store.snapshot()).toMatchObject({
      active: [],
      recent: [{
        requestId: 'req-1',
        state: 'completed',
        status: 200,
        durationMs: 40,
      }],
      totals: {
        started: 1,
        completed: 1,
        failed: 0,
      },
    })
    expect(store.summary()).toMatchObject({
      active: 0,
      recent: 1,
      totals: { started: 1, completed: 1, failed: 0 },
      effectCounts: { 'model.compact_route': 1 },
    })
  })

  test(`hard-caps completed history at exactly ${RECENT_REQUEST_LIMIT}`, () => {
    let now = 0
    const store = new RequestActivityStore(() => now)

    for (let index = 0; index < RECENT_REQUEST_LIMIT + 44; index++) {
      store.start({
        requestId: `req-${index}`,
        method: 'POST',
        endpoint: '/v1/responses',
      })
      now++
      store.complete(`req-${index}`, 200)
    }

    const snapshot = store.snapshot()
    expect(snapshot.active).toHaveLength(0)
    expect(snapshot.recent).toHaveLength(RECENT_REQUEST_LIMIT)
    expect(snapshot.recent[0]?.requestId).toBe('req-299')
    expect(snapshot.recent.at(-1)?.requestId).toBe('req-44')
  })

  test('keeps in-flight requests separate from the completed ring', () => {
    const store = new RequestActivityStore(() => 1)

    for (let index = 0; index < RECENT_REQUEST_LIMIT; index++) {
      store.start({ requestId: `done-${index}`, method: 'GET', endpoint: '/health' })
      store.complete(`done-${index}`, 200)
    }
    store.start({ requestId: 'active-1', method: 'POST', endpoint: '/v1/messages' })

    const snapshot = store.snapshot()
    expect(snapshot.active.map(request => request.requestId)).toEqual(['active-1'])
    expect(snapshot.recent).toHaveLength(RECENT_REQUEST_LIMIT)
  })

  test('stores only bounded metadata and safe effect counts', () => {
    const store = new RequestActivityStore(() => 1)
    store.start({
      requestId: 'req-safe',
      method: 'POST',
      endpoint: '/v1/responses',
      requestedModel: `gpt-5.6\nBearer secret ${'x'.repeat(300)}`,
    })
    store.recordEffect('req-safe', 'responses.parameter_filter')
    store.recordEffect('req-safe', 'responses.parameter_filter')
    store.recordError('req-safe', 'Upstream HTTP 429 (rate_limit_error)')
    store.complete('req-safe', 429)

    const json = JSON.stringify(store.snapshot())
    expect(json).not.toContain('Bearer secret')
    expect(json).not.toContain('prompt')
    expect(json).not.toContain('headers')
    expect(store.snapshot().recent[0]).toMatchObject({
      state: 'failed',
      effects: [{ id: 'responses.parameter_filter', count: 2 }],
      errorSummary: 'Upstream HTTP 429 (rate_limit_error)',
    })
  })

  test('buffers attempt effects until commit and drops discarded attempts', () => {
    const store = new RequestActivityStore(() => 1_000)
    store.start({ requestId: 'commit', method: 'POST', endpoint: '/v1/responses' })
    store.beginEffectBuffer('commit')
    store.recordEffect('commit', 'responses.parameter_filter', 2)

    expect(store.snapshot().active[0]?.effects).toEqual([])
    expect(store.summary().effectCounts).toEqual({})

    store.commitEffectBuffer('commit')
    expect(store.snapshot().active[0]?.effects).toEqual([
      { id: 'responses.parameter_filter', count: 2 },
    ])
    expect(store.summary().effectCounts).toEqual({
      'responses.parameter_filter': 2,
    })

    store.start({ requestId: 'discard', method: 'POST', endpoint: '/v1/responses' })
    store.beginEffectBuffer('discard')
    store.recordEffect('discard', 'responses.input_compacted')
    store.discardEffectBuffer('discard')

    expect(store.snapshot().active.find(request => request.requestId === 'discard')?.effects).toEqual([])
    expect(store.summary().effectCounts).toEqual({
      'responses.parameter_filter': 2,
    })
  })

  test('records client-aborted delivery separately from completed and failed requests', () => {
    let now = 1_000
    const store = new RequestActivityStore(() => now)
    store.start({
      requestId: 'req-aborted',
      method: 'POST',
      endpoint: '/v1/responses',
    })
    store.markStreaming('req-aborted')

    now = 1_025
    store.markAborted('req-aborted')
    store.complete('req-aborted', 200)

    expect(store.snapshot()).toMatchObject({
      active: [],
      recent: [{
        requestId: 'req-aborted',
        state: 'aborted',
        status: 200,
        durationMs: 25,
      }],
      totals: {
        started: 1,
        completed: 0,
        failed: 0,
        aborted: 1,
      },
    })
    expect(store.summary().totals).toEqual({
      started: 1,
      completed: 0,
      failed: 0,
      aborted: 1,
    })
  })

  test('reclassifies a just-completed delivery when client abort arrives late', () => {
    const store = new RequestActivityStore(() => 1_000)
    store.start({
      requestId: 'req-late-abort',
      method: 'POST',
      endpoint: '/v1/responses',
    })
    store.markStreaming('req-late-abort')
    store.complete('req-late-abort', 200)

    store.markAborted('req-late-abort')
    store.markAborted('req-late-abort')

    expect(store.snapshot()).toMatchObject({
      recent: [{ requestId: 'req-late-abort', state: 'aborted' }],
      totals: {
        started: 1,
        completed: 0,
        failed: 0,
        aborted: 1,
      },
    })
  })

  test('does not overwrite an upstream failure with a later client abort', () => {
    const store = new RequestActivityStore(() => 1_000)
    store.start({
      requestId: 'req-failed-before-abort',
      method: 'POST',
      endpoint: '/v1/responses',
    })
    store.recordError('req-failed-before-abort', 'Upstream HTTP 500 (upstream_error)')
    store.complete('req-failed-before-abort', 200)

    store.markAborted('req-failed-before-abort')

    expect(store.snapshot()).toMatchObject({
      recent: [{ requestId: 'req-failed-before-abort', state: 'failed' }],
      totals: {
        started: 1,
        completed: 1,
        failed: 1,
        aborted: 0,
      },
    })
  })

  test.each([
    'error-before-abort',
    'abort-before-error',
  ])('keeps an active upstream failure authoritative for %s ordering', (ordering) => {
    const store = new RequestActivityStore(() => 1_000)
    store.start({
      requestId: ordering,
      method: 'POST',
      endpoint: '/v1/responses',
    })

    if (ordering === 'error-before-abort') {
      store.recordError(ordering, 'Upstream HTTP 500 (upstream_error)')
      store.markAborted(ordering)
    }
    else {
      store.markAborted(ordering)
      store.recordError(ordering, 'Upstream HTTP 500 (upstream_error)')
    }
    store.complete(ordering, 200)

    expect(store.snapshot()).toMatchObject({
      recent: [{
        requestId: ordering,
        state: 'failed',
        errorSummary: 'Upstream HTTP 500 (upstream_error)',
      }],
      totals: {
        started: 1,
        completed: 1,
        failed: 1,
        aborted: 0,
      },
    })
  })
})

describe('dashboard metadata sanitizers', () => {
  test('normalizes known dynamic endpoints without retaining resource ids or query strings', () => {
    expect(classifyObservedEndpoint('http://localhost/v1/responses/resp_secret/input_items?include=all'))
      .toBe('/v1/responses/:responseId/input_items')
    expect(classifyObservedEndpoint('http://localhost/private/token-in-path'))
      .toBe('unmatched')
    expect(classifyObservedEndpoint('http://localhost/dashboard')).toBeUndefined()
    expect(classifyObservedEndpoint('http://localhost/dashboard/api/requests')).toBeUndefined()
    expect(classifyObservedEndpoint('http://localhost/dashboarding')).toBe('unmatched')
    expect(classifyObservedEndpoint('http://localhost/responses/input_tokens'))
      .toBe('/responses/input_tokens')
    expect(classifyObservedEndpoint('http://localhost/v1/responses/input_tokens?model=gpt'))
      .toBe('/v1/responses/input_tokens')
    expect(classifyObservedEndpoint('http://localhost/v1/responses/input_tokens/'))
      .toBe('/v1/responses/input_tokens')
  })

  test('classifies errors without storing raw messages', () => {
    expect(sanitizeObservedError(new Error('prompt text and Bearer secret'), 'UNKNOWN', 500))
      .toBe('Unhandled proxy error')
    expect(sanitizeObservedError(new DOMException('timed out', 'TimeoutError'), 'UNKNOWN', 504))
      .toBe('Upstream timeout')
    expect(sanitizeObservedError({ body: { error: { type: 'rate_limit_error' } } }, 'HTTP', 429))
      .toBe('HTTP 429 (rate_limit_error)')
    expect(sanitizeObservedError({ body: { error: { type: 'invalid_request_error', code: 'unsupported_input' } } }, 'HTTP', 400))
      .toBe('HTTP 400 (unsupported_input)')
    expect(sanitizeObservedError({ body: { error: { type: 'translation_error', code: 'unsupported_server_tool' } } }, 'HTTP', 400))
      .toBe('HTTP 400 (translation_error)')
    expect(sanitizeObservedError({ body: { error: { type: 'invalid_request_error', code: null } } }, 'HTTP', 400))
      .toBe('HTTP 400 (invalid_request_error)')
    expect(sanitizeObservedError({ body: { error: { type: 'secret_token_123' } } }, 'HTTP', 400))
      .toBe('HTTP 400')
    expect(sanitizeObservedError({ body: { error: { type: 'not_found_error' } } }, 'HTTP', 404))
      .toBe('HTTP 404 (not_found_error)')
  })
})
