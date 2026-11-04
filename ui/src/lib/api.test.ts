import { describe, expect, it } from 'vitest'
import { overviewFixture } from '../test/fixtures'
import { ApiError, createDashboardApi, SchemaMismatchError } from './api'

describe('injected typed Dashboard API', () => {
  it.each([403, 404, 421, 503])('preserves %s status and the server error type/message', async (status) => {
    const api = createDashboardApi(async () => Response.json({ error: { message: 'A source-specific failure', type: 'invalid_request_error' } }, { status }))
    const request = api.overview()
    await expect(request).rejects.toMatchObject({ status, type: 'invalid_request_error', message: 'A source-specific failure' })
    await expect(request).rejects.toBeInstanceOf(ApiError)
  })

  it('does not accept an incompatible schema as page data', async () => {
    const api = createDashboardApi(async () => Response.json({ ...overviewFixture(), schemaVersion: 999 }))
    await expect(api.overview()).rejects.toBeInstanceOf(SchemaMismatchError)
  })

  it('rejects the legacy Dashboard schema before consumers access removed fields', async () => {
    const api = createDashboardApi(async () => Response.json({
      schemaVersion: 1,
      generatedAt: '2026-11-04T00:10:00.000Z',
      status: 'ok',
      auth: { upstream: 'github' },
      quota: { status: 'unavailable' },
    }))
    await expect(api.overview()).rejects.toBeInstanceOf(SchemaMismatchError)
  })
})
