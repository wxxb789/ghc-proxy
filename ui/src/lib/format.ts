import type { DashboardModel, DashboardQuotaDetail, DashboardTokenPriceTier, UpstreamQueueSnapshot } from '@contract'

const numberFormat = new Intl.NumberFormat()
const usdFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

const pad2 = (value: number) => String(value).padStart(2, '0')
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const TSV_BREAK_RE = /[\t\r\n]+/g

/** Durations: `812 ms`, `1.2 s`, `12 s`, `4m 07s`, `3h 12m`, `2d 4h`. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms))
    return '—'
  if (ms < 1000)
    return `${Math.max(0, Math.round(ms))} ms`
  if (ms < 10_000)
    return `${(ms / 1000).toFixed(1)} s`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60)
    return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return `${minutes}m ${pad2(seconds % 60)}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `${hours}h ${pad2(minutes % 60)}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** Countdown `mm:ss` (device code expiry). Negative values clamp to `00:00`. */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`
}

export function formatNumber(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) ? numberFormat.format(value) : '—'
}

/** `81.2 %`; non-finite values render `—`, never `NaN%`. */
export function formatPercent(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) ? `${value.toFixed(1)} %` : '—'
}

function toDate(value: string | number | Date | undefined | null): Date | null {
  if (value === undefined || value === null || value === '')
    return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Absolute local time. Date-only strings (quota reset dates) pass through unchanged. */
export function formatDate(value: string | undefined): string {
  if (value && DATE_ONLY_RE.test(value))
    return value
  return toDate(value)?.toLocaleString() ?? '—'
}

/** 24-hour `HH:MM:SS` (or `HH:MM` without seconds) in local time. */
export function formatClock(value: string | number | Date | undefined | null, seconds = true): string {
  const date = toDate(value)
  if (!date)
    return '—'
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  return seconds ? `${clock}:${pad2(date.getSeconds())}` : clock
}

/** `HH:MM:SS` for today, else the full local date. */
export function formatClockOrDate(value: string | number | Date | undefined | null, now = Date.now()): string {
  const date = toDate(value)
  if (!date)
    return '—'
  return date.toDateString() === new Date(now).toDateString() ? formatClock(date) : date.toLocaleString()
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [['hour', 3_600_000], ['minute', 60_000], ['second', 1000]]

/** `12 seconds ago` / `in 28 minutes` up to 24 h; empty beyond that (an absolute time is always shown alongside). */
export function relTime(value: string | number | Date | undefined | null, now = Date.now()): string {
  const date = toDate(value)
  if (!date)
    return ''
  const delta = date.getTime() - now
  if (Math.abs(delta) >= 86_400_000)
    return ''
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(delta) >= size || unit === 'second')
      return relativeFormat.format(Math.trunc(delta / size), unit)
  }
  return ''
}

export function compactJson(value: unknown): string {
  if (value === null || value === undefined)
    return '—'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : pluralForm}`
}

/** Quota pool cell: missing `—`, unlimited `Unlimited`, else `remaining / entitlement`. */
export function formatQuotaPool(detail: DashboardQuotaDetail | undefined): string {
  if (!detail)
    return '—'
  return detail.unlimited ? 'Unlimited' : `${formatNumber(detail.remaining)} / ${formatNumber(detail.entitlement)}`
}

/** `none` / `account` / `2 models` / `account + 2 models`. */
export function formatCooldowns(queue: Pick<UpstreamQueueSnapshot, 'accountCooldown' | 'modelCooldowns'>): string {
  const models = queue.modelCooldowns > 0 ? plural(queue.modelCooldowns, 'model') : ''
  if (queue.accountCooldown)
    return models ? `account + ${models}` : 'account'
  return models || 'none'
}

/** One TSV cell: tabs and line breaks collapse to a space so the row structure survives. */
export function tsvCell(value: unknown): string {
  return String(value ?? '').replace(TSV_BREAK_RE, ' ').trim()
}

const formatTsvNumber = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? numberFormat.format(value) : '-'

function modelLimitLines(model: DashboardModel): string[] {
  const limits = model.upstream.capabilities.limits
  return [
    `context ${formatTsvNumber(limits.max_context_window_tokens)}`,
    `prompt ${formatTsvNumber(limits.max_prompt_tokens)}`,
    `output ${formatTsvNumber(limits.max_output_tokens)}`,
  ]
}

function priceRows(tier: DashboardTokenPriceTier): [string, string][] {
  const image = (tier.imageInput ?? 0) > 0 || (tier.imageOutput ?? 0) > 0
  const rates = [
    [image ? 'text in' : 'in', tier.input],
    ['out', image && tier.output === 0 ? undefined : tier.output],
    ['cache', tier.cacheRead || undefined],
    ['write', tier.cacheWrite || undefined],
    ['img in', tier.imageInput || undefined],
    ['img out', tier.imageOutput || undefined],
  ] as const
  if (!rates.some(([, rate]) => rate !== undefined && rate > 0))
    return [['Included', '']]
  return rates.flatMap(([label, rate]) => rate === undefined ? [] : [[label, `$${usdFormat.format(rate)}`]])
}

export function modelPriceGroups(model: DashboardModel) {
  const prices = model.upstream.billing?.tokenPrices
  if (!prices)
    return []

  const groups = [{ heading: '', rows: priceRows(prices.default) }]
  if (prices.longContext) {
    const threshold = prices.default.maxPromptTokens
    const heading = threshold === undefined ? 'Long context' : `>${threshold >= 1000 && threshold % 1000 === 0 ? `${threshold / 1000}k` : formatNumber(threshold)}`
    groups.push({ heading, rows: priceRows(prices.longContext) })
  }
  return groups
}

export function modelCapabilities(model: DashboardModel): string[] {
  const supports = model.upstream.capabilities.supports
  return Object.keys(supports).filter((key) => {
    const value = supports[key]
    return value === true || (Array.isArray(value) && value.length > 0)
  })
}

export function modelCompatibilityLines(model: DashboardModel): string[] {
  const effective = model.effective
  if (effective.defaultMessagesStrategy === 'unavailable') {
    const endpoints = model.upstream.endpoints
    return [
      `images generations ${endpoints.includes('/v1/images/generations') ? 'available' : 'unavailable'}`,
      `images edits ${endpoints.includes('/v1/images/edits') ? 'available' : 'unavailable'}`,
    ]
  }
  const responses = effective.defaultResponsesStrategy === 'responses-passthrough'
    ? 'native'
    : effective.defaultResponsesStrategy === 'responses-chat-completions' ? 'via Chat Completions' : 'unavailable'
  return [
    `responses ${responses}`,
    `structured ${effective.messagesStructuredOutput ? 'yes' : 'no'}`,
    `output_config ${effective.outputConfig ? 'yes' : 'no'}`,
    `chat tokens ${effective.chatTokenParameter}`,
    effective.responsesParameterFilters.length ? `filters ${effective.responsesParameterFilters.join(',')}` : 'filters none',
    effective.contextManagement ? 'context managed' : 'context passthrough',
  ]
}

const TSV_HEADER = ['Model ID', 'Model Name', 'Vendor', 'Version', 'Messages Route', 'Upstream Endpoints', 'Limits', 'Price (USD / 1M tokens)', 'Capabilities', 'Proxy Compatibility']

export function modelsTsv(models: DashboardModel[], origin: string): string {
  const rows = [...models]
    .sort((left, right) => String(left.name || left.id).localeCompare(String(right.name || right.id)))
    .map(model => [
      model.id,
      model.name + (model.preview ? ' / preview' : ''),
      model.vendor,
      model.version,
      model.effective.defaultMessagesStrategy,
      model.upstream.endpoints.join(', ') || '-',
      modelLimitLines(model).join('; '),
      modelPriceGroups(model).map(({ heading, rows }) => {
        const rates = rows.map(([label, price]) => price ? `${label} ${price}` : label).join('; ')
        return heading ? `${heading}: ${rates}` : rates
      }).join(' | ') || '-',
      modelCapabilities(model).join(', ') || '-',
      modelCompatibilityLines(model).join('; '),
    ].map(tsvCell).join('\t'))
  return [`Endpoint: ${origin}/v1`, TSV_HEADER.join('\t'), ...rows].join('\n')
}
