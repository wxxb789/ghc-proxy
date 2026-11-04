import { describe, expect, it } from 'vitest'
import { buildUrl, pageUrl, parseUrl, redirectUrl } from './url-state'

describe('bookmarkable string-only Dashboard URLs', () => {
  it.each(['all', '123', '1.0', '1e3', 'null', 'true', 'm365', 'A.b-c_d', 'a'.repeat(64), 'work.localhost'])('round-trips target %s without coercion', (target) => {
    const state = { page: 'requests' as const, target, window: '24h' as const, request: 'request/1', state: 'failed', endpoint: '/v1/messages', model: 'a+b / c' }
    expect(parseUrl(buildUrl(state))).toEqual(state)
  })

  it('distinguishes all targets from an account literally named all and omits defaults', () => {
    const allTargets = new URL(buildUrl({ page: 'overview', window: '1h' }), 'http://localhost')
    const namedAll = new URL(buildUrl({ page: 'overview', window: '1h', target: 'all' }), 'http://localhost')
    expect(allTargets.searchParams.has('target')).toBe(false)
    expect(allTargets.searchParams.has('window')).toBe(false)
    expect(namedAll.searchParams.get('target')).toBe('all')
  })

  it('normalizes an unknown window while preserving string filters', () => {
    expect(parseUrl('/dashboard/traffic?window=unknown&target=null')).toMatchObject({ page: 'traffic', window: '1h', target: 'null' })
    expect(parseUrl('/dashboard')).toMatchObject({ page: 'overview' })
    expect(parseUrl('/dashboard/not-a-page').page).toBeNull()
  })

  it('carries only the global target and window into sidebar navigation', () => {
    const next = parseUrl(pageUrl({ page: 'requests', window: '15m', target: 'work', request: 'old', model: 'claude', state: 'failed' }, 'traffic'))
    expect(next).toMatchObject({ page: 'traffic', window: '15m', target: 'work' })
    expect(next.request).toBeUndefined()
    expect(next.model).toBeUndefined()
    expect(next.state).toBeUndefined()
  })

  it('redirects with protocol, port, page and window but no target or request', () => {
    const result = new URL(redirectUrl({ protocol: 'https:', port: '4141' }, 'localhost', { page: 'requests', window: '24h', target: 'removed', request: 'r1', state: 'failed' }))
    expect(result.protocol).toBe('https:')
    expect(result.hostname).toBe('localhost')
    expect(result.port).toBe('4141')
    expect(parseUrl(result)).toMatchObject({ page: 'requests', window: '24h', target: undefined, request: undefined, state: undefined })
  })
})
