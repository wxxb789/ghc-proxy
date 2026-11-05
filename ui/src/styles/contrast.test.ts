/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Read from disk: Vitest does not process CSS imports.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.css'), 'utf8')

/** The two token blocks (spec §3.1): `:root { …dark… }` and `:root[data-theme='light'] { … }`. */
function tokenBlock(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  const body = css.slice(start, css.indexOf('}', start))
  return Object.fromEntries(Array.from(body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi), match => [match[1]!, match[2]!]))
}

const THEMES = { dark: tokenBlock(':root'), light: tokenBlock(':root[data-theme=\'light\']') }

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function ratio(theme: keyof typeof THEMES, fg: string, bg: string): number {
  const tokens = THEMES[theme]
  const [a, b] = [luminance(tokens[fg]!), luminance(tokens[bg]!)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const TINTS = ['ok-bg', 'warn-bg', 'bad-bg', 'info-bg', 'accent-tint']
const TONE_FG = ['ok-fg', 'warn-fg', 'bad-fg', 'info-fg']
const SURFACES = ['bg-0', 'bg-1', 'bg-2', 'bg-3']

// [foreground(s), background(s), dark values, light values, requirement]; several fg/bg → pairwise, or the minimum when one value is given.
const TABLE: Array<[string[], string[], number[], number[], number]> = [
  [['text-1'], SURFACES, [16.52, 15.57, 14.11, 12.99], [17.21, 18.92, 15.84, 18.92], 4.5],
  [['text-1'], ['accent-tint'], [13.28], [16.21], 4.5],
  [['text-2'], SURFACES, [9.57, 9.02, 8.17, 7.52], [7.90, 8.69, 7.27, 8.69], 4.5],
  [['text-2'], TINTS, [7.49], [7.44], 4.5],
  [['text-3'], SURFACES, [6.53, 6.16, 5.58, 5.14], [5.70, 6.27, 5.25, 6.27], 4.5],
  [['text-3'], ['bg-inset'], [6.68], [5.49], 4.5],
  [['text-3'], ['accent-tint'], [5.25], [5.37], 4.5],
  [['text-3'], ['ok-bg', 'warn-bg', 'bad-bg', 'info-bg'], [5.11, 5.14, 5.50, 5.29], [5.50, 5.52, 5.41, 5.52], 4.5],
  [['text-3'], ['input-bg'], [6.53], [6.27], 4.5],
  [['accent'], SURFACES, [7.51, 7.08, 6.41, 5.91], [5.63, 6.20, 5.19, 6.20], 4.5],
  [['accent'], ['accent-tint'], [6.04], [5.31], 3],
  [['accent-fg'], ['accent', 'accent-hover'], [7.51, 9.29], [6.20, 7.65], 4.5],
  [['ok-fg'], ['bg-1', 'ok-bg', 'bg-3'], [10.22, 8.49, 8.53], [6.34, 5.56, 6.34], 4.5],
  [['warn-fg'], ['bg-1', 'warn-bg', 'bg-3'], [9.92, 8.28, 8.28], [6.68, 5.88, 6.68], 4.5],
  [['bad-fg'], ['bg-1', 'bad-bg', 'bg-3'], [7.33, 6.54, 6.12], [6.58, 5.67, 6.58], 4.5],
  [['info-fg'], ['bg-1', 'info-bg', 'bg-3'], [9.09, 7.81, 7.58], [5.91, 5.21, 5.91], 4.5],
  [TONE_FG, ['bg-2'], [6.64], [4.95], 4.5],
  [TONE_FG, ['accent-tint'], [6.25], [5.06], 4.5],
  [['danger-fill-fg'], ['danger-fill', 'danger-fill-hover'], [6.91, 5.88], [6.58, 8.15], 4.5],
  [['line-control'], SURFACES, [4.43, 4.17, 3.78, 3.48], [3.64, 4.01, 3.35, 4.01], 3],
  [['ok-line', 'warn-line', 'bad-line', 'info-line'], ['bg-1'], [4.97, 4.46, 3.73, 4.19], [3.73, 3.89, 3.84, 3.58], 3],
  [['chart-ink-1', 'chart-ink-2', 'chart-ink-3'], ['bg-1'], [11.87, 6.24, 3.67], [12.93, 4.74, 3.59], 3],
  [['chart-ink-2'], ['bg-inset'], [6.77], [4.15], 3],
  [['focus'], [...SURFACES, 'bg-inset', 'input-bg'], [5.91], [5.19], 3],
]

describe('design tokens (spec §3.2–§3.4)', () => {
  it('parses both complete token blocks', () => {
    for (const tokens of Object.values(THEMES))
      expect(Object.keys(tokens)).toHaveLength(36)
  })

  for (const theme of ['dark', 'light'] as const) {
    describe(theme, () => {
      it.each(TABLE)('%j on %j', (fgs, bgs, dark, light, required) => {
        const pairs = fgs.flatMap(fg => bgs.map(bg => ratio(theme, fg, bg)))
        const expected = theme === 'dark' ? dark : light
        const actual = expected.length === 1 ? [Math.min(...pairs)] : pairs
        expect(actual).toHaveLength(expected.length)
        actual.forEach((value, index) => {
          expect(value).toBeGreaterThanOrEqual(required)
          expect(value).toBeCloseTo(expected[index]!, 1)
        })
      })
    })
  }
})
