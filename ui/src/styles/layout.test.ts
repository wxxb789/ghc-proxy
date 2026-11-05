/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Read from disk: Vitest does not process CSS imports, and jsdom does no layout.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.css'), 'utf8')

/** Declarations of the first top-level rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const match = css.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))
  return match?.[1] ?? ''
}

describe('shared layout rules', () => {
  it('lets empty-state text wrap inside nowrap table cells', () => {
    expect(rule('.empty')).toMatch(/white-space: normal;/)
    expect(rule('.empty')).toMatch(/overflow-wrap: anywhere;/)
  })
})
