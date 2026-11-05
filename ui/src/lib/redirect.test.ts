import { describe, expect, it } from 'vitest'
import { baseDashboardUrl, isLoopbackHost, redirectToBase } from './redirect.ts'
import { faults, timers } from './store.svelte.ts'

function fakeLocation(href: string, events: string[]) {
  return { href, replace: (url: string) => events.push(`replace ${url}`) }
}

describe('isLoopbackHost', () => {
  it.each(['localhost', 'work.localhost', 'a.b.localhost', '127.0.0.1', '[::1]', '::1', 'LOCALHOST'])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true)
  })

  it.each(['example.com', 'localhost.evil.com', '0.0.0.0', '10.0.0.1', ''])('rejects %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false)
  })
})

describe('redirectToBase (T:284-304, T:406-429)', () => {
  it.each([
    'http://work.localhost:4187/dashboard',
    'http://127.0.0.1:4187/dashboard#/accounts',
    'http://0.0.0.0:4187/dashboard',
    'http://default-account.localhost:4187/dashboard',
  ])('stops polling before leaving %s for localhost on the same port', (href) => {
    const events: string[] = []
    const redirected = redirectToBase('localhost', fakeLocation(href, events), () => events.push('stop'))
    expect(redirected).toBe(true)
    expect(events).toEqual(['stop', 'replace http://localhost:4187/dashboard#/accounts'])
  })

  it('clears the real Live interval and device-auth timer before location.replace', () => {
    timers.live = setInterval(() => {}, 2000)
    timers.deviceAuth = setTimeout(() => {}, 1000)
    let stoppedFirst = false
    redirectToBase('localhost', {
      href: 'http://work.localhost:4187/dashboard',
      replace: () => {
        stoppedFirst = timers.live === undefined && timers.deviceAuth === undefined
      },
    })
    expect(stoppedFirst).toBe(true)
  })

  it('refuses an unexpected base hostname and records an accounts fault', () => {
    const events: string[] = []
    expect(redirectToBase('evil.example.com', fakeLocation('http://localhost:4187/dashboard', events), () => events.push('stop'))).toBe(false)
    expect(events).toEqual([])
    expect(faults.accounts?.message).toBe('Unexpected base hostname "evil.example.com". Open the Dashboard on that hostname manually.')
  })

  it('keeps protocol and port in the preview URL', () => {
    expect(baseDashboardUrl('localhost', 'https://127.0.0.1:9000/dashboard#/accounts?section=add')).toBe('https://localhost:9000/dashboard#/accounts')
    expect(baseDashboardUrl('::1', 'http://localhost:4141/dashboard')).toBe('http://[::1]:4141/dashboard#/accounts')
  })
})
