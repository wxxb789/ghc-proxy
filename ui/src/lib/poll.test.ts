import type { RegionResult } from './poll'
import { describe, expect, it } from 'vitest'
import { ApiError, SchemaMismatchError } from './api'
import { deriveRegion, pollingInterval } from './poll'

const ready = { data: { count: 0 }, error: null, isPending: false, isFetching: false }

describe('query policy', () => {
  it('backs transport failures off exponentially without accelerating slow windows', () => {
    const network = new TypeError('Network unavailable')
    expect([0, 1, 2, 3, 4, 5].map(failures => pollingInterval(3_000, failures, network))).toEqual([3_000, 6_000, 12_000, 24_000, 30_000, 30_000])
    expect(pollingInterval(60_000, 4, network)).toBe(60_000)
    expect(pollingInterval(10_000, 2, new ApiError('Unavailable', 503))).toBe(30_000)
    expect(pollingInterval(3_000, 0, null)).toBe(3_000)
  })

  it.each([new ApiError('Forbidden', 403), new ApiError('Wrong host', 421), new SchemaMismatchError()])('stops automatic updates for %s', (error) => {
    expect(pollingInterval(3_000, 1, error)).toBe(false)
  })

  it('distinguishes all seven region states and preserves successful zero values', () => {
    const states: RegionResult<{ count: number }>[] = [
      deriveRegion<{ count: number }>({ ...ready, data: undefined, isPending: true }, 0),
      deriveRegion(ready, 0),
      deriveRegion({ ...ready, isFetching: true }, 0),
      deriveRegion(ready, 0, true),
      deriveRegion({ ...ready, error: new Error('Second failure') }, 2),
      deriveRegion(ready, 0, false, true),
      deriveRegion({ ...ready, error: new Error('First failure') }, 1),
    ]
    expect(states.map(region => region.state)).toEqual(['loading', 'ready', 'refreshing', 'empty', 'stale', 'unavailable', 'error'])
    expect(states[1].data?.count).toBe(0)
    expect(states[4].data?.count).toBe(0)
    expect(states[6].data?.count).toBe(0)
  })
})
