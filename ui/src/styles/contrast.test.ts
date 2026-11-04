import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = await readFile(resolve(import.meta.dirname, 'index.css'), 'utf8')

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)!.map(channel => Number.parseInt(channel, 16) / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function contrast(a: string, b: string): number {
  const first = luminance(a)
  const second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

for (const theme of ['light', 'dark']) {
  const declarations = theme === 'light' ? css.match(/:root\s*\{([^}]+)\}/)![1] : css.match(/:root\[data-theme='dark'\]\s*\{([^}]+)\}/)![1]
  const tokens = Object.fromEntries(Array.from(declarations.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi), match => [match[1], match[2]]))
  describe(`${theme} theme token contrast`, () => {
    for (const surface of ['page', 'surface', 'surface-soft']) {
      it.each(['ink', 'ink-muted', 'completed', 'failed', 'aborted'])(`keeps %s text readable on ${surface}`, (ink) => {
        expect(contrast(tokens[ink], tokens[surface])).toBeGreaterThanOrEqual(4.5)
      })
      it.each(['focus', 'completed', 'failed', 'aborted'])(`keeps %s marks distinguishable on ${surface}`, (mark) => {
        expect(contrast(tokens[mark], tokens[surface])).toBeGreaterThanOrEqual(3)
      })
    }
  })
}
