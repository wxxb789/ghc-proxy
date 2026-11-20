import { colorize } from 'consola/utils'

import { copilotBaseUrl } from '~/clients/api-config'
import { getClientConfig } from '~/clients/factory'
import { getEffectiveModelFallbackConfig } from '~/lib/model-resolver'
import { authStore, getCurrentAccountName } from '~/state'
import { VERSION } from '~/util/version'

export function printStartupBanner(serverUrl: string): void {
  const lines = [`ghc-proxy v${VERSION}`, '']

  const info = (label: string, value: string) =>
    `  ${colorize('dim', label.padEnd(12))}${value}`

  const account = authStore.upstream === 'm365'
    ? authStore.mscAuthUsername ?? authStore.mscAuthAccount
    : authStore.githubLogin
  const dashboardUrl = new URL('/dashboard', serverUrl)
  dashboardUrl.hostname = '127.0.0.1'
  lines.push(
    info('Account', account ?? getCurrentAccountName()),
    info('Endpoint', copilotBaseUrl(getClientConfig())),
    info('Dashboard', dashboardUrl.href),
    info('Local Proxy', colorize('cyan', serverUrl)),
  )

  const fallbacks = getEffectiveModelFallbackConfig()
  lines.push('')
  lines.push(`  ${colorize('bold', 'Fallbacks')}`)
  lines.push(`    ${colorize('dim', 'claude-opus-*')}    -> ${fallbacks.claudeOpus}`)
  lines.push(`    ${colorize('dim', 'claude-sonnet-*')}  -> ${fallbacks.claudeSonnet}`)
  lines.push(`    ${colorize('dim', 'claude-haiku-*')}   -> ${fallbacks.claudeHaiku}`)

  console.log(lines.join('\n'))
}
