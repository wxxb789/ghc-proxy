import type { AccountRuntime } from '~/state'

import { describe, expect, spyOn, test } from 'bun:test'

import { printStartupBanner } from '~/cli/startup-banner'
import { M365_DEFAULT_ENDPOINT } from '~/lib/m365-endpoints'
import { createAccountRuntime, runWithAccountRuntime } from '~/state'
import { VERSION } from '~/util/version'
import { buildModel, buildModelsResponse } from './helpers'

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'g')

function captureBanner(runtime: AccountRuntime, serverUrl: string): string {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    runWithAccountRuntime(runtime, () => printStartupBanner(serverUrl))
    expect(log).toHaveBeenCalledTimes(1)
    return String(log.mock.calls[0]?.[0]).replace(ANSI_RE, '')
  }
  finally {
    log.mockRestore()
  }
}

describe('startup banner', () => {
  test('shows only connection details and fallbacks even with a populated model cache', () => {
    const runtime = createAccountRuntime('default', {
      githubLogin: 'octocat',
      copilotApiBase: 'https://copilot.example.test/',
    })
    runtime.models.cacheModels(buildModelsResponse(buildModel('claude-opus-5')))
    runtime.models.setVSCodeVersion('1.91.0')
    const banner = captureBanner(runtime, 'http://proxy.example.test:4141')

    expect(banner.split('\n').map(line => line.trim().replace(/ +/g, ' ')).filter(Boolean)).toEqual([
      `ghc-proxy v${VERSION}`,
      'Account octocat',
      'Endpoint https://copilot.example.test',
      'Dashboard http://127.0.0.1:4141/dashboard',
      'Local Proxy http://proxy.example.test:4141',
      'Fallbacks',
      'claude-opus-* -> claude-opus-5.5',
      'claude-sonnet-* -> claude-sonnet-5.5',
      'claude-haiku-* -> claude-haiku-5.5',
    ])
  })

  test.each([
    { username: 'broker-user@example.test', account: 'broker-account', expected: 'broker-user@example.test' },
    { username: undefined, account: 'broker-account', expected: 'broker-account' },
    { username: undefined, account: undefined, expected: 'office' },
  ])('shows the M365 account $expected and gateway endpoint', ({ username, account, expected }) => {
    const runtime = createAccountRuntime('office', {
      upstream: 'm365',
      githubLogin: 'unrelated-login',
      mscAuthUsername: username,
      mscAuthAccount: account,
    })
    const banner = captureBanner(runtime, 'http://localhost:4141')

    expect(banner).toContain(`Account     ${expected}`)
    expect(banner).toContain(`Endpoint    ${M365_DEFAULT_ENDPOINT}`)
    expect(banner).toContain('Dashboard   http://127.0.0.1:4141/dashboard')
  })
})
