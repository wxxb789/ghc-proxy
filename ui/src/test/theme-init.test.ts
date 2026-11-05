/// <reference types="node" />
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import source from '../../public/theme-init.js?raw'

/** Runs the classic pre-paint script in an isolated context; returns `<html>` dataset. */
function run(stored: string | null | Error, prefersDark: boolean): Record<string, string> {
  const dataset: Record<string, string> = {}
  runInNewContext(source, {
    localStorage: {
      getItem: () => {
        if (stored instanceof Error)
          throw stored
        return stored
      },
    },
    matchMedia: (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && prefersDark }),
    document: { documentElement: { dataset } },
  })
  return dataset
}

describe('theme-init.js (spec §3.1)', () => {
  it('applies a stored explicit theme regardless of the system', () => {
    expect(run('light', true)).toEqual({ theme: 'light', themePref: 'light' })
    expect(run('dark', false)).toEqual({ theme: 'dark', themePref: 'dark' })
  })

  it('follows the system when nothing is stored', () => {
    expect(run(null, true)).toEqual({ theme: 'dark', themePref: 'system' })
    expect(run(null, false)).toEqual({ theme: 'light', themePref: 'system' })
  })

  it('ignores invalid values and unavailable storage', () => {
    expect(run('sepia', false)).toEqual({ theme: 'light', themePref: 'system' })
    expect(run(new Error('denied'), true)).toEqual({ theme: 'dark', themePref: 'system' })
  })
})
