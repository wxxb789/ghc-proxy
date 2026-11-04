import type { DashboardQuantile } from '@contract'

const number = new Intl.NumberFormat('en', { maximumFractionDigits: 1 })
const integer = new Intl.NumberFormat('en', { maximumFractionDigits: 0 })

export function formatNumber(value: number | null | undefined): string {
  return value == null ? '—' : number.format(value)
}

export function formatInteger(value: number | null | undefined): string {
  return value == null ? '—' : integer.format(value)
}

export function formatPercent(value: number | null | undefined): string {
  return value == null ? '—' : `${number.format(value * 100)}%`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null)
    return '—'
  if (ms < 1_000)
    return `${number.format(ms)} ms`
  if (ms < 60_000)
    return `${number.format(ms / 1_000)} s`
  return `${number.format(ms / 60_000)} min`
}

export function formatQuantile(quantile: DashboardQuantile | null): string {
  if (!quantile)
    return '—'
  const prefix = { 'exact': '', 'approximate': '≈ ', 'at-most': '≤ ', 'at-least': '≥ ' }[quantile.kind]
  return `${prefix}${formatDuration(quantile.valueMs)}`
}

export function formatDateTime(value: string | number | undefined): string {
  return value === undefined ? '—' : new Date(value).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'medium' })
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  const previous = document.activeElement
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.className = 'clipboard-helper'
  textarea.setAttribute('readonly', '')
  document.body.append(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy'))
      throw new Error('Copy was unavailable. Select and copy the text manually.')
  }
  finally {
    textarea.remove()
    if (previous instanceof HTMLElement)
      previous.focus()
  }
}
