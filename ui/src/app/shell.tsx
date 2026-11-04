import type { DashboardPage } from '@contract'
import type { ReactNode } from 'react'
import type { ThemePreference } from '../lib/theme'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { Link } from 'wouter'
import { StatusChip } from '../components/primitives'
import { useMetadataRefresh } from '../lib/mutations'
import { queryMeta } from '../lib/poll'
import { useOverview, useTargets } from '../lib/queries'
import { useTheme } from '../lib/theme'
import { isMonitorPage, PAGE_LABELS, pageUrl } from '../lib/url-state'
import { useDashboard, useDashboardUrl } from './context'

export interface ShellProps { children: ReactNode, title?: string, description?: string, actions?: ReactNode }
const GROUPS: readonly { label: string, pages: readonly DashboardPage[] }[] = [
  { label: 'Monitor', pages: ['overview', 'traffic', 'requests'] },
  { label: 'Configure', pages: ['targets', 'models', 'behavior'] },
]

export function Shell({ children, title, description, actions }: ShellProps) {
  const runtime = useDashboard()
  const { announce } = runtime
  const { url, navigate } = useDashboardUrl()
  const overview = useOverview()
  const needsTargets = isMonitorPage(url.page) || url.page === 'targets'
  const targets = useTargets(needsTargets)
  const refresh = useMetadataRefresh()
  const [theme, setTheme] = useTheme()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const menuRef = useRef<HTMLDetailsElement>(null)
  const menuTriggerRef = useRef<HTMLElement>(null)
  const pageTitle = title ?? (url.page ? PAGE_LABELS[url.page] : 'Page not found')
  const subscribe = useCallback((listener: () => void) => runtime.client.getQueryCache().subscribe(listener), [runtime.client])
  const snapshot = useCallback(() => {
    const active = runtime.client.getQueryCache().findAll({ type: 'active', predicate: query => Boolean(queryMeta(query)) && queryMeta(query)?.domain !== 'authentication' })
    return active.length > 0 && active.every(query => query.state.error !== null)
  }, [runtime.client])
  const connectionLost = useSyncExternalStore(subscribe, snapshot, () => false)
  const wasLostRef = useRef(false)

  useEffect(() => {
    document.title = `${pageTitle} · ghc-proxy Dashboard`
    headingRef.current?.focus()
    if (menuRef.current)
      menuRef.current.open = false
  }, [url.page, pageTitle])
  useEffect(() => {
    if (connectionLost !== wasLostRef.current) {
      announce(connectionLost ? 'Connection lost. Each region keeps its last known data.' : 'Connection restored.')
      wasLostRef.current = connectionLost
    }
  }, [connectionLost, announce])
  useEffect(() => {
    if (targets.data && url.target !== undefined
      && (!targets.data.routing.routingEnabled || !targets.data.targets.some(target => target.name === url.target))) {
      navigate({ target: undefined })
      announce(targets.data.routing.routingEnabled
        ? 'The selected target no longer exists. Showing all targets.'
        : 'Named target filtering is unavailable for this legacy process. Showing all traffic.')
    }
  }, [targets.data, url.target, navigate, announce])

  const links = GROUPS.map(group => (
    <div key={group.label} className="nav-group">
      <p className="nav-group-label">{group.label}</p>
      {group.pages.map(page => <Link key={page} href={pageUrl(url, page)} aria-current={url.page === page ? 'page' : undefined}>{PAGE_LABELS[page]}</Link>)}
    </div>
  ))
  const refreshReason = overview.data?.capabilities.canRefreshMetadata
    ? undefined
    : overview.data?.capabilities.refreshUnavailableReason ?? 'Metadata refresh capabilities are not available yet.'

  return (
    <div className="dashboard-shell">
      <a className="skip-link" href="#dashboard-main">Skip to content</a>
      <aside className="sidebar">
        <Link className="brand" href={pageUrl(url, 'overview')}>
          ghc-proxy
          <span>Local workspace</span>
        </Link>
        <nav aria-label="Dashboard navigation">{links}</nav>
        <p className="sidebar-note">
          Live process insights.
          <br />
          Nothing stored beyond this session.
        </p>
      </aside>
      <div className="workspace">
        <header className="app-header">
          <details
            ref={menuRef}
            className="mobile-menu"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && menuRef.current?.open) {
                menuRef.current.open = false
                menuTriggerRef.current?.focus()
                event.preventDefault()
              }
            }}
          >
            <summary ref={menuTriggerRef}>Menu</summary>
            <nav aria-label="Mobile Dashboard navigation">{links}</nav>
          </details>
          <div className="header-health">
            {overview.data
              ? (
                  <>
                    <StatusChip state={overview.error ? 'stale' : overview.data.status} />
                    <span className="version">
                      v
                      {overview.data.version}
                    </span>
                  </>
                )
              : <span className="muted">{overview.error ? 'Health unavailable' : 'Connecting…'}</span>}
          </div>
          <div className="header-controls">
            <button
              type="button"
              className="live-control"
              aria-pressed={runtime.live}
              disabled={runtime.stopped || runtime.schemaMismatch}
              onClick={() => {
                runtime.setLive(live => !live)
                runtime.announce(runtime.live ? 'Live updates paused.' : 'Live updates resumed.')
              }}
            >
              <span className={runtime.live ? 'live-dot active' : 'live-dot'} aria-hidden="true" />
              Live
              <span className="sr-only"> updates</span>
            </button>
            <button
              type="button"
              disabled={Boolean(refreshReason) || refresh.isPending || runtime.stopped || runtime.schemaMismatch}
              aria-describedby={refreshReason ? 'refresh-unavailable' : undefined}
              onClick={() => {
                if (runtime.client.isMutating({ mutationKey: ['dashboard', 'refresh'] }) === 0)
                  refresh.mutate()
              }}
            >
              {refresh.isPending ? 'Refreshing…' : 'Refresh'}
            </button>
            <label className="theme-control">
              <span className="sr-only">Theme</span>
              <select aria-label="Theme" value={theme} onChange={event => setTheme(event.target.value as ThemePreference)}>
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
          </div>
        </header>
        {refreshReason && (
          <p id="refresh-unavailable" className="refresh-reason">
            Refresh unavailable:
            {refreshReason}
          </p>
        )}
        {overview.error && (
          <p className="refresh-reason">
            Health update unavailable:
            {overview.region.explanation ?? overview.error.message}
            {overview.data && ' Last known health is shown.'}
          </p>
        )}
        {needsTargets && targets.error && (
          <p className="refresh-reason">
            Target list unavailable:
            {targets.region.explanation ?? targets.error.message}
            {targets.data && ' Last known targets are shown.'}
          </p>
        )}
        <div className="transition-status" role="status" aria-atomic="true">{runtime.notice}</div>
        {connectionLost && <p className="connection-warning">Connection lost. Showing last known data where available.</p>}
        <main id="dashboard-main" className="main-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">{isMonitorPage(url.page) ? 'Monitor' : 'Configure'}</p>
              <h1 ref={headingRef} tabIndex={-1}>{runtime.schemaMismatch ? 'Reload required' : pageTitle}</h1>
              {description && <p className="page-description">{description}</p>}
            </div>
            {actions}
          </div>
          {runtime.schemaMismatch
            ? (
                <section className="card">
                  <p>This Dashboard and proxy use different API versions. Reload before continuing.</p>
                  <button type="button" onClick={() => window.location.reload()}>Reload Dashboard</button>
                </section>
              )
            : (
                <>
                  {isMonitorPage(url.page) && targets.data && targets.data.targets.length > 1 && (
                    <div className="global-filter">
                      <label htmlFor="global-target">Route target</label>
                      <select id="global-target" value={url.target ?? ''} onChange={event => navigate({ target: event.target.value || undefined, request: undefined })}>
                        <option value="">All targets</option>
                        {targets.data.targets.map(target => <option key={target.runtimeId} value={target.name}>{target.name}</option>)}
                      </select>
                    </div>
                  )}
                  {url.page
                    ? children
                    : (
                        <section className="card">
                          <p>This page does not exist.</p>
                          <Link href={pageUrl(url, 'overview')}>Open Overview</Link>
                        </section>
                      )}
                </>
              )}
        </main>
      </div>
    </div>
  )
}
