import type { Model } from '~/types'

import { colorize } from 'consola/utils'

import { getModelFallbackConfig } from '~/lib/model-resolver'
import { authStore, modelCache } from '~/state'
import { VERSION } from '~/util/version'

export function printStartupBanner(serverUrl: string): void {
  const lines: string[] = []

  // Header
  lines.push(`ghc-proxy v${VERSION}`)
  lines.push('')

  // Info section
  const info = (label: string, value: string) =>
    `  ${colorize('dim', label.padEnd(11))}${value}`

  const vsCodeVersion = modelCache.getVSCodeVersion()
  if (vsCodeVersion)
    lines.push(info('VSCode', vsCodeVersion))
  if (authStore.githubLogin)
    lines.push(info('Account', authStore.githubLogin))
  if (authStore.copilotApiBase)
    lines.push(info('Endpoint', authStore.copilotApiBase))

  // Models section
  const models = modelCache.getModels()?.data ?? []
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
