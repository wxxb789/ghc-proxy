import type { Model } from '~/types'

import { colorize } from 'consola/utils'

import { getModelFallbackConfig } from './model-resolver'
import { state } from './state'
import { VERSION } from './version'

export function printStartupBanner(serverUrl: string): void {
  const lines: string[] = []

  // Header
  lines.push(`ghc-proxy v${VERSION}`)
  lines.push('')

  // Info section
  const info = (label: string, value: string) =>
    `  ${colorize('dim', label.padEnd(11))}${value}`

  if (state.cache.vsCodeVersion)
    lines.push(info('VSCode', state.cache.vsCodeVersion))
  if (state.cache.githubLogin)
    lines.push(info('Account', state.cache.githubLogin))
  if (state.auth.copilotApiBase)
    lines.push(info('Endpoint', state.auth.copilotApiBase))

  // Models section
  const models = state.cache.models?.data ?? []
  if (models.length > 0) {
    lines.push('')
    lines.push(`  ${colorize('bold', 'Models')}`)

    const grouped = groupAndSortModels(models)
    for (const [vendor, vendorModels] of grouped) {
      lines.push('')
      lines.push(`  ${colorize('dim', vendor)}`)
      for (const model of vendorModels) {
        const ctx = formatContextWindow(model)
        const id = model.id.padEnd(27)
        lines.push(`    ${id}${colorize('dim', ctx)}`)
      }
    }
  }

  // Fallbacks section
  const fallbacks = getModelFallbackConfig()
  lines.push('')
  lines.push(`  ${colorize('bold', 'Fallbacks')}`)
  lines.push(`    ${colorize('dim', 'claude-opus-*')}    -> ${fallbacks.claudeOpus}`)
  lines.push(`    ${colorize('dim', 'claude-sonnet-*')}  -> ${fallbacks.claudeSonnet}`)
  lines.push(`    ${colorize('dim', 'claude-haiku-*')}   -> ${fallbacks.claudeHaiku}`)

  // Listening
  lines.push('')
  lines.push(`  Listening on ${colorize('cyan', serverUrl)}`)

  // eslint-disable-next-line no-console
  console.log(lines.join('\n'))
}

function groupAndSortModels(models: Model[]): Map<string, Model[]> {
  const grouped = new Map<string, Model[]>()
  for (const model of models) {
    const vendor = model.vendor
    const list = grouped.get(vendor) ?? []
    list.push(model)
    grouped.set(vendor, list)
  }
  // Sort each group by version (date string) descending
  for (const [, list] of grouped) {
    list.sort((a, b) => b.version.localeCompare(a.version))
  }
  return grouped
}

function formatContextWindow(model: Model): string {
  const tokens = model.capabilities?.limits?.max_context_window_tokens
  if (!tokens)
    return ''
  const k = Math.round(tokens / 1000)
  return `${k}k ctx`
}
