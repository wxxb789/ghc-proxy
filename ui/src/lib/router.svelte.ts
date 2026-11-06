import { tick } from 'svelte'
import { announce, app } from './store.svelte.ts'

export const VIEWS = ['overview', 'requests', 'accounts', 'models', 'behavior'] as const
export type View = typeof VIEWS[number]

export const VIEW_LABEL: Record<View, string> = {
  overview: 'Overview',
  requests: 'Requests',
  accounts: 'Accounts',
  models: 'Models',
  behavior: 'Behavior',
}

export type Params = Record<string, string>

const nonEmpty = (value: string) => value.length > 0
const REQUEST_STATE_RE = /^(?:active|completed|failed|aborted|errors)$/
const HASH_PREFIX_RE = /^#\/?/
/** Accepted params per view; anything else (including default values) is dropped from the URL. */
const PARAM_RULES: Record<View, Record<string, (value: string) => boolean>> = {
  overview: { section: value => value === 'quota' },
  requests: { id: nonEmpty, state: value => REQUEST_STATE_RE.test(value), q: nonEmpty },
  accounts: { section: value => value === 'add' || value === 'm365' },
  models: { q: nonEmpty, group: value => value === '0', sort: value => value === 'desc', target: nonEmpty },
  behavior: {},
}

const isView = (value: string): value is View => (VIEWS as readonly string[]).includes(value)

function cleanParams(view: View, params: Record<string, string | undefined>): Params {
  const rules = PARAM_RULES[view]
  const clean: Params = {}
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && Object.hasOwn(rules, key) && rules[key]!(value))
      clean[key] = value
  }
  return clean
}

/** `#/view?a=b` with only valid, non-default params. */
export function buildHash(view: View, params: Record<string, string | undefined> = {}): string {
  const query = new URLSearchParams(cleanParams(view, params)).toString()
  return `#/${view}${query ? `?${query}` : ''}`
}

/** Parses a location hash; `view` is null for an unknown view. An empty hash is Overview. */
export function parseHash(hash: string): { view: View | null, params: Params } {
  const [path = '', query = ''] = hash.replace(HASH_PREFIX_RE, '').split('?')
  const view = path || 'overview'
  if (!isView(view))
    return { view: null, params: {} }
  return { view, params: cleanParams(view, Object.fromEntries(new URLSearchParams(query))) }
}

export const router = $state({ view: 'overview' as View, params: {} as Params })

/** Reads `location.hash` into the router; an unknown view is replaced by `#/overview`. */
function readLocation(): void {
  const parsed = parseHash(location.hash)
  if (!parsed.view)
    history.replaceState(null, '', '#/overview')
  router.view = parsed.view ?? 'overview'
  router.params = parsed.params
}

/** Pushes a history entry; the `hashchange` listener updates the router. */
export function navigate(view: View, params?: Record<string, string | undefined>): void {
  location.hash = buildHash(view, params)
}

/**
 * Merges `patch` into the current view's params without a history entry
 * (filters, sort, selection, section). `undefined` removes a param.
 */
export function replaceParams(patch: Record<string, string | undefined>): void {
  const params = cleanParams(router.view, { ...router.params, ...patch })
  history.replaceState(null, '', buildHash(router.view, params))
  router.params = params
}

/** Focuses a heading after the DOM settles; section headings use the id `<section>-h`. */
export async function focusHeading(id: string): Promise<void> {
  await tick()
  document.getElementById(id)?.focus({ preventScroll: id === 'view-h1' })
}

/**
 * `section=` is a one-shot jump (spec §2.1): focus that panel's h2, then drop
 * the param without a history entry so the same link works again.
 */
async function focusSection(section: string): Promise<void> {
  await focusHeading(`${section}-h`)
  if (router.params.section === section)
    replaceParams({ section: undefined })
}

/**
 * In-app link to the current hash: browsers fire no `hashchange` for it, so
 * focus its target heading directly. Returns true when the link was handled.
 */
export function revisit(hash: string): boolean {
  if (hash !== location.hash)
    return false
  const section = parseHash(hash).params.section
  void (section ? focusSection(section) : focusHeading('view-h1'))
  return true
}

function setTitle(view: View): void {
  document.title = `${VIEW_LABEL[view]} · ghc-proxy`
}

/**
 * Installs the `hashchange` listener (spec §10.4). `onViewEnter` runs for a
 * real view change (the poller's `refreshSelectedView`). The initial parse
 * sets the title only and moves no focus. Returns a stop function.
 */
export function startRouter(onViewEnter: (view: View) => void): () => void {
  readLocation()
  setTitle(router.view)
  const onHashChange = () => {
    const previous = router.view
    const previousTarget = router.params.target
    readLocation()
    const section = router.params.section
    if (router.view !== previous) {
      // Shortcuts and Back/Forward navigate from outside the overlays: close them before focus moves.
      app.ui.issuesOpen = false
      app.ui.drawerOpen = false
      setTitle(router.view)
      document.documentElement.scrollTop = 0
      announce(VIEW_LABEL[router.view])
      void (section ? focusSection(section) : focusHeading('view-h1'))
      onViewEnter(router.view)
    }
    else {
      if (section)
        void focusSection(section)
      // Models' `target` picks which catalog loads, so Back/Forward or an edited hash reloads it.
      if (router.params.target !== previousTarget)
        onViewEnter(router.view)
    }
  }
  addEventListener('hashchange', onHashChange)
  return () => removeEventListener('hashchange', onHashChange)
}
