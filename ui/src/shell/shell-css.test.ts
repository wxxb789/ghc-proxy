/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Read from disk: Vitest does not process CSS imports, and jsdom does no layout or media queries.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles/app.css'), 'utf8')

/** Declarations of every rule whose selector is exactly `selector`, at any nesting depth, in file order. */
function rules(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return Array.from(css.matchAll(new RegExp(`^\\s*${escaped} \\{([^}]*)\\}`, 'gm')), match => match[1]!)
}

describe('shell chrome rules', () => {
  it('dims the page behind the open drawer, except under forced colors', () => {
    const [drawer, forced] = rules('.rail.open')
    expect(drawer).toMatch(/box-shadow: var\(--shadow-pop\), 0 0 0 100vmax var\(--scrim\);/)
    expect(forced).toMatch(/box-shadow: none;/)
  })

  it('keeps nav digit hints quiet: no box', () => {
    expect(rules('.nav-item kbd')[0]).toMatch(/border: 0;/)
  })
})
