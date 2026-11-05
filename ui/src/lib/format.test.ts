import { describe, expect, it } from 'vitest'
import { model } from '../test/fixtures.ts'
import { formatClock, formatClockOrDate, formatCooldowns, formatCountdown, formatDate, formatDuration, formatPercent, formatQuotaPool, modelsTsv, relTime, tsvCell } from './format.ts'

describe('durations (spec §7.2)', () => {
  it.each([
    [812, '812 ms'],
    [1234, '1.2 s'],
    [12_400, '12 s'],
    [247_000, '4m 07s'],
    [11_527_000, '3h 12m'],
    [187_200_000, '2d 4h'],
    [Number.NaN, '—'],
    [undefined, '—'],
  ])('%s → %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text)
  })

  it('formats the device-code countdown', () => {
    expect(formatCountdown(872_000)).toBe('14:32')
    expect(formatCountdown(-5)).toBe('00:00')
  })
})

describe('values', () => {
  it('never renders NaN%', () => {
    expect(formatPercent(81.24)).toBe('81.2 %')
    expect(formatPercent(Number.NaN)).toBe('—')
  })

  it('formats clocks and dates', () => {
    const date = new Date(2026, 10, 5, 9, 4, 7)
    expect(formatClock(date)).toBe('09:04:07')
    expect(formatClock(date, false)).toBe('09:04')
    expect(formatClock('nope')).toBe('—')
    expect(formatDate('2026-12-01')).toBe('2026-12-01')
    expect(formatDate(undefined)).toBe('—')
  })

  it('shows the clock for today and the full date otherwise', () => {
    const now = new Date(2026, 10, 5, 14, 0, 0).getTime()
    expect(formatClockOrDate(new Date(2026, 10, 5, 9, 4, 7).toISOString(), now)).toBe('09:04:07')
    const yesterday = new Date(2026, 10, 4, 9, 4, 7)
    expect(formatClockOrDate(yesterday.toISOString(), now)).toBe(yesterday.toLocaleString())
    expect(formatClockOrDate(undefined, now)).toBe('—')
  })

  it('formats relative times up to 24 h', () => {
    const now = Date.parse('2026-11-05T14:00:00Z')
    expect(relTime('2026-11-05T13:59:48Z', now)).toBe('12 seconds ago')
    expect(relTime('2026-11-05T14:28:00Z', now)).toBe('in 28 minutes')
    expect(relTime('2026-11-03T14:00:00Z', now)).toBe('')
  })

  it('formats quota pools and cooldowns', () => {
    expect(formatQuotaPool(undefined)).toBe('—')
    expect(formatQuotaPool({ entitlement: 0, remaining: 0, percentRemaining: 100, unlimited: true, overagePermitted: false })).toBe('Unlimited')
    expect(formatQuotaPool({ entitlement: 1000, remaining: 812, percentRemaining: 81.2, unlimited: false, overagePermitted: false })).toBe('812 / 1,000')
    expect(formatCooldowns({ accountCooldown: false, modelCooldowns: 0 })).toBe('none')
    expect(formatCooldowns({ accountCooldown: true, modelCooldowns: 0 })).toBe('account')
    expect(formatCooldowns({ accountCooldown: false, modelCooldowns: 2 })).toBe('2 models')
    expect(formatCooldowns({ accountCooldown: true, modelCooldowns: 1 })).toBe('account + 1 model')
  })
})

describe('models TSV (legacy F§3.13, byte-identical)', () => {
  it('collapses tabs and line breaks in a cell', () => {
    expect(tsvCell(' a\t\tb\r\nc ')).toBe('a b c')
    expect(tsvCell(undefined)).toBe('')
    expect(tsvCell(null)).toBe('')
  })

  it('sorts by name || id and keeps the legacy cell formats', () => {
    const opus = model({ id: 'claude-opus-5.5', name: 'Claude Opus 5.5', preview: true })
    const gpt = model({
      id: 'gpt-5.4',
      name: '',
      vendor: 'OpenAI',
      version: 'gpt-5.4-2026',
      upstream: { endpoints: [], capabilities: { limits: { max_context_window_tokens: 400_000 }, supports: { streaming: true } } },
      effective: {
        ...opus.effective,
        defaultMessagesStrategy: 'chat-completions',
        defaultResponsesStrategy: null,
        messagesStructuredOutput: false,
        outputConfig: false,
        chatTokenParameter: 'max_completion_tokens',
        responsesParameterFilters: ['temperature', 'top_p'],
        contextManagement: false,
      },
    })
    const expected = [
      'Endpoint: http://localhost:4141/v1',
      'Model ID\tModel Name\tVendor\tVersion\tMessages Route\tUpstream Endpoints\tLimits\tCapabilities\tProxy Compatibility',
      'claude-opus-5.5\tClaude Opus 5.5 / preview\tAnthropic\t2026-09-01\tnative-messages\t/v1/messages, /chat/completions\tcontext 200,000; prompt 168,000; output 64,000\ttool_calls, vision, reasoning_effort\tresponses native; structured yes; output_config yes; chat tokens max_tokens; filters none; context managed',
      'gpt-5.4\t\tOpenAI\tgpt-5.4-2026\tchat-completions\t-\tcontext 400,000; prompt -; output -\tstreaming\tresponses unavailable; structured no; output_config no; chat tokens max_completion_tokens; filters temperature,top_p; context passthrough',
    ].join('\n')
    expect(modelsTsv([gpt, opus], 'http://localhost:4141')).toBe(expected)
  })
})
