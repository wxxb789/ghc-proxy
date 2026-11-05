import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeFetch } from '../test/fake-fetch.ts'
import { authSession, resetAccountsState } from '../test/fixtures-accounts.ts'
import { addForm, claimCardFocus, DEVICE_AUTH_POLL_MS, safeVerificationUri, startDeviceAuth } from './device-auth.svelte.ts'
import { stopAll } from './poller.svelte.ts'
import { app, timers } from './store.svelte.ts'

const envelope = { schemaVersion: 1, generatedAt: '2026-11-05T14:02:11.000Z' }
const body = { accountName: 'team', hostname: 'team.localhost', gheDomain: '' }

function install(session = authSession()) {
  const fake = createFakeFetch({
    'POST /dashboard/api/accounts': () => ({ ...envelope, authentication: session }),
    '/dashboard/api/account-auth/auth-1': () => ({ ...envelope, authentication: session }),
  })
  vi.stubGlobal('fetch', fake.fetch)
  return fake
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  resetAccountsState()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('safeVerificationUri', () => {
  it.each([
    ['https://github.com/login/device', 'https://github.com/login/device'],
    ['http://github.com/login/device', null],
    ['javascript:alert(1)', null],
    ['data:text/html,hi', null],
    ['not a url', null],
  ])('%s -> %s', (value, expected) => {
    expect(safeVerificationUri(value)).toBe(expected)
  })
})

describe('device-auth poll chain', () => {
  it('polls every second from the store-owned timer, and stopAll() ends the chain', async () => {
    const fake = install()
    await startDeviceAuth(body)
    expect(app.deviceAuth.busy).toBe(true)
    expect(timers.deviceAuth).toBeDefined()
    await vi.advanceTimersByTimeAsync(DEVICE_AUTH_POLL_MS - 1)
    expect(fake.count('GET')).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.count('GET')).toBe(1)
    await vi.advanceTimersByTimeAsync(DEVICE_AUTH_POLL_MS)
    expect(fake.count('GET')).toBe(2)

    stopAll()
    expect(timers.deviceAuth).toBeUndefined()
    await vi.advanceTimersByTimeAsync(5 * DEVICE_AUTH_POLL_MS)
    expect(fake.count('GET')).toBe(2)
  })

  it('stopAll() during an in-flight poll keeps the chain stopped once it resolves', async () => {
    const fake = install()
    await startDeviceAuth(body)
    const held = fake.hold('GET /dashboard/api/account-auth/auth-1')
    await vi.advanceTimersByTimeAsync(DEVICE_AUTH_POLL_MS)
    expect(fake.count('GET')).toBe(1)

    stopAll()
    held.release()
    await vi.advanceTimersByTimeAsync(5 * DEVICE_AUTH_POLL_MS)
    expect(timers.deviceAuth).toBeUndefined()
    expect(fake.count('GET')).toBe(1)
  })

  it('stopAll() while the start request is in flight keeps polling from starting', async () => {
    const fake = install()
    const held = fake.hold('POST /dashboard/api/accounts')
    const started = startDeviceAuth(body)
    stopAll()
    held.release()
    await started
    expect(timers.deviceAuth).toBeUndefined()
    await vi.advanceTimersByTimeAsync(5 * DEVICE_AUTH_POLL_MS)
    expect(fake.count('GET')).toBe(0)
  })

  it('ignores a submit while a session holds the lock', async () => {
    const fake = install()
    await startDeviceAuth(body)
    await startDeviceAuth(body)
    expect(fake.count('POST')).toBe(1)
    expect(addForm.status.text).toBe('Authorize in GitHub')
  })

  it('gives each session its card focus exactly once', () => {
    expect(claimCardFocus('a')).toBe(true)
    expect(claimCardFocus('a')).toBe(false)
    expect(claimCardFocus('b')).toBe(true)
  })
})
