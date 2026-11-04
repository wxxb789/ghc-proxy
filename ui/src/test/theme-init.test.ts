import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { beforeEach, describe, expect, it } from 'vitest'

const initializer = await readFile(resolve(import.meta.dirname, '../../public/theme-init.js'), 'utf8')
const storageKey = 'ghc-proxy-dashboard-theme'

beforeEach(() => {
  window.localStorage.clear()
  delete document.documentElement.dataset.theme
})

describe('theme initialization before the application loads', () => {
  it.each(['light', 'dark'])('applies the persisted %s preference', (theme) => {
    window.localStorage.setItem(storageKey, theme)

    runInNewContext(initializer, { document, localStorage: window.localStorage })

    expect(document.documentElement.dataset.theme).toBe(theme)
  })

  it.each([null, 'system', 'unknown'])('leaves %s to the system stylesheet', (theme) => {
    if (theme !== null)
      window.localStorage.setItem(storageKey, theme)

    runInNewContext(initializer, { document, localStorage: window.localStorage })

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})
