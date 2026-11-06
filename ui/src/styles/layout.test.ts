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

const requestList = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../views/requests/RequestList.svelte'), 'utf8')

describe('shared layout rules', () => {
  // Chromium stops vertical wheel chaining at a sideways-scrolling table whose `overscroll-behavior` contains
  // both axes, so a wide Models catalog froze the page. Only the Requests list scrolls vertically inside itself.
  it('contains table overscroll sideways only, so a wide table never traps the page scroll', () => {
    expect(rule('.table-scroll')).toMatch(/overscroll-behavior-x: contain;/)
    expect(rule('.table-scroll')).not.toMatch(/overscroll-behavior(?:-y)?:/)
    expect(requestList).toMatch(/\.req-scroll \{[^}]*overscroll-behavior-y: contain;/)
  })

  it('lets empty-state text wrap inside nowrap table cells', () => {
    expect(rule('.empty')).toMatch(/white-space: normal;/)
    expect(rule('.empty')).toMatch(/overflow-wrap: anywhere;/)
  })
})
