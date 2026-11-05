import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildHash, parseHash } from './router.svelte.ts'

describe('parseHash and buildHash', () => {
  it('treats an empty hash as Overview and rejects unknown views', () => {
    expect(parseHash('')).toEqual({ view: 'overview', params: {} })
    expect(parseHash('#/')).toEqual({ view: 'overview', params: {} })
    expect(parseHash('#/responses')).toEqual({ view: null, params: {} })
  })

  it('keeps only valid params for the view', () => {
    expect(parseHash('#/requests?state=failed&q=opus&id=req_1&sort=desc').params).toEqual({ state: 'failed', q: 'opus', id: 'req_1' })
    expect(parseHash('#/requests?state=bogus').params).toEqual({})
    expect(parseHash('#/accounts?section=m365').params).toEqual({ section: 'm365' })
    expect(parseHash('#/accounts?section=other').params).toEqual({})
    expect(parseHash('#/models?group=0&sort=desc').params).toEqual({ group: '0', sort: 'desc' })
  })

  it('omits default and empty values', () => {
    expect(buildHash('models', { group: '1', sort: 'asc', q: '' })).toBe('#/models')
    expect(buildHash('requests', { state: 'all', q: 'x' })).toBe('#/requests?q=x')
    expect(buildHash('behavior', { q: 'x' })).toBe('#/behavior')
  })
})

describe('router runtime', () => {
  let stop: (() => void) | undefined
  afterEach(() => stop?.())

  async function load(hash: string) {
    vi.resetModules()
    history.replaceState(null, '', `/dashboard${hash}`)
    const router = await import('./router.svelte.ts')
    const { announcer } = await import('./store.svelte.ts')
    const entered: string[] = []
    stop = router.startRouter(view => entered.push(view))
    return { ...router, announcer, entered }
  }

  it('replaces an unknown view with #/overview without a history entry', async () => {
    const before = history.length
    const { router } = await load('#/nope')
    expect(location.hash).toBe('#/overview')
    expect(router.view).toBe('overview')
    expect(history.length).toBe(before)
    expect(document.title).toBe('Overview · ghc-proxy')
  })

  it('pushes view changes and runs title, focus, announce and the view-entry load', async () => {
    const { navigate, router, announcer, entered } = await load('#/overview')
    document.body.innerHTML = '<h1 id="view-h1" tabindex="-1">Models</h1>'
    const before = history.length
    navigate('models')
    await vi.waitFor(() => expect(router.view).toBe('models'))
    expect(history.length).toBe(before + 1)
    expect(document.title).toBe('Models · ghc-proxy')
    expect(announcer.text).toContain('Models')
    expect(entered).toEqual(['models'])
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('view-h1'))
  })

  it('focuses the section heading for section=', async () => {
    const { navigate, router } = await load('#/overview')
    document.body.innerHTML = '<h1 id="view-h1" tabindex="-1">Accounts</h1><h2 id="m365-h" tabindex="-1">M365</h2>'
    const before = history.length
    navigate('accounts', { section: 'm365' })
    await vi.waitFor(() => expect(router.view).toBe('accounts'))
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('m365-h'))
    // One-shot: the param is dropped without a history entry, so the same link works again.
    await vi.waitFor(() => expect(location.hash).toBe('#/accounts'))
    expect(router.params).toEqual({})
    expect(history.length).toBe(before + 1)
    ;(document.activeElement as HTMLElement).blur()
    navigate('accounts', { section: 'm365' })
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('m365-h'))
  })

  it('revisit focuses the target of a link to the current hash, which fires no hashchange', async () => {
    const { revisit, router } = await load('#/overview?section=quota')
    document.body.innerHTML = '<h1 id="view-h1" tabindex="-1">Overview</h1><h2 id="quota-h" tabindex="-1">Quota</h2>'
    expect(revisit('#/accounts')).toBe(false)
    expect(revisit('#/overview?section=quota')).toBe(true)
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('quota-h'))
    await vi.waitFor(() => expect(location.hash).toBe('#/overview'))
    expect(router.params).toEqual({})
    expect(revisit('#/overview')).toBe(true)
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('view-h1'))
  })

  it('replaceParams merges params without a history entry or a view-entry load', async () => {
    const { replaceParams, router, entered } = await load('#/requests?state=failed')
    const before = history.length
    replaceParams({ q: 'opus' })
    replaceParams({ state: undefined, id: 'req_9' })
    expect(location.hash).toBe('#/requests?q=opus&id=req_9')
    expect(router.params).toEqual({ q: 'opus', id: 'req_9' })
    expect(history.length).toBe(before)
    expect(entered).toEqual([])
  })
})
