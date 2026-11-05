import type {
  AccountAuthenticationSession,
  AccountsResponse,
  BehaviorResponse,
  M365DashboardState,
  M365ProbeResponse,
  ModelsResponse,
  OverviewResponse,
  RequestsResponse,
} from '@contract'
import type { Sample } from './samples.ts'

export type DataScope = 'overview' | 'accounts' | 'models' | 'behavior' | 'requests'
export type Scope = DataScope | 'metadata'

export const SCOPE_LABEL: Record<Scope, string> = {
  overview: 'Overview',
  accounts: 'Accounts',
  models: 'Models',
  behavior: 'Behavior',
  requests: 'Requests',
  metadata: 'Metadata refresh',
}

export interface Fault {
  scope: Scope
  message: string
  since: Date
  count: number
}

/** Fault per scope (a `$state` record: deleting a key notifies readers). */
export type Faults = Partial<Record<Scope, Fault>>

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'lost' | 'blocked'
export type AccountsMode = 'unknown' | 'routing' | 'legacy' | 'unavailable'
export type ThemePref = 'system' | 'light' | 'dark'
export interface ReadinessLine { text: string, tone?: 'ok' | 'bad' }

/** Last-known payloads. `$state.raw`: replaced on every load, never mutated in place. */
class LastKnown {
  overview = $state.raw<OverviewResponse | null>(null)
  accounts = $state.raw<AccountsResponse | null>(null)
  m365 = $state.raw<M365DashboardState | null>(null)
  models = $state.raw<ModelsResponse | null>(null)
  behavior = $state.raw<BehaviorResponse | null>(null)
  requests = $state.raw<RequestsResponse | null>(null)
}

/** The overview sample ring (spec §6.3) plus the first sample since page open or restart. */
class SampleBuffer {
  list = $state.raw<Sample[]>([])
  first = $state.raw<Sample | null>(null)
}

export const app = $state({
  data: new LastKnown(),
  loadedAt: { overview: null, accounts: null, m365: null, models: null, behavior: null, requests: null } as Record<DataScope | 'm365', Date | null>,
  accountsMode: 'unknown' as AccountsMode,
  connection: {
    state: 'connecting' as ConnectionState,
    failures: 0,
    rttMs: null as number | null,
    lostSince: null as Date | null,
    /** 403/421 server message while `blocked`. */
    blockedMessage: '',
    blockedStatus: 0,
  },
  live: true,
  /** When the last proxy restart was detected (§6.7). */
  restartedAt: null as Date | null,
  busy: { metadata: false, bootstrap: false, m365Target: false, m365Probe: false, m365SignIn: false, m365Account: false, m365Hostname: false },
  accountBusy: {} as Record<string, 'default' | 'remove' | undefined>,
  /** Device-auth flow (owned by device-auth.svelte.ts); its timer handle lives in `timers`. */
  deviceAuth: { busy: false, session: null as AccountAuthenticationSession | null },
  m365: {
    /** JSON snapshot of the last applied state; '' forces the next load to re-apply. */
    snapshotKey: '',
    /** Panel view state; replaced only when the snapshot changes (spec §5.3.4). */
    view: null as M365DashboardState | null,
    /** Last probe result (broker accounts, readiness). */
    probe: null as M365ProbeResponse | null,
    probeStarted: false,
    readiness: [] as ReadinessLine[],
    /** `#m365-status` text. Load and mutation errors land here, never in `faults`. */
    status: '',
    statusIsError: false,
    drafts: { endpoint: '', custom: '', hostname: '', registerHostname: '', registerAccount: '', account: '', signInUpn: '' },
    dirty: { endpoint: false, hostname: false },
  },
  /** Selected model ids; arrays (mutated in place) instead of sets keep svelte/reactivity out of the bundle. */
  selection: { requestId: null as string | null, models: [] as string[] },
  ui: {
    insightsOpen: true,
    rawJsonOpen: true,
    behaviorRaw: { routing: false, params: false },
    hideZeroEffects: false,
    /** Target names whose Details row is open. */
    detailsOpen: [] as string[],
    issuesOpen: false,
    drawerOpen: false,
    shortcutsOpen: false,
    /** Dismissed issue ids (P1 restart notices). */
    dismissed: [] as string[],
  },
  prefs: { theme: 'system' as ThemePref, shortcuts: true },
  bootstrapSuggested: '',
})

/** Fault per scope; cleared only when the same scope succeeds (or `metadata` is dismissed). */
export const faults: Faults = $state({})
export const samples = new SampleBuffer()
/** Behavior effect counts at the first successful load since open/restart (§6.6). */
export const effectsBaseline = $state({ map: null as Map<string, number> | null })

/** Timer handles kept outside `$state`. `stopAll()` clears every one before a redirect. */
export const timers = {
  live: undefined as ReturnType<typeof setInterval> | undefined,
  deviceAuth: undefined as ReturnType<typeof setTimeout> | undefined,
}

/** One polite live region; speaks transitions only. */
export const announcer = $state({ text: '' })
let lastAnnounceAt = 0

/** Messages within 250 ms of each other (one poll settling) are spoken together. */
export function announce(text: string): void {
  const now = Date.now()
  announcer.text = now - lastAnnounceAt < 250 && announcer.text ? `${announcer.text} ${text}` : text
  lastAnnounceAt = now
}

export function faultMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Dashboard refresh failed'
}

export function raiseFault(scope: Scope, reason: unknown): void {
  const message = faultMessage(reason)
  const now = new Date()
  const existing = faults[scope]
  faults[scope] = existing
    ? { ...existing, message, count: existing.count + 1 }
    : { scope, message, since: now, count: 1 }
  if (!existing || existing.message !== message)
    announce(scope === 'metadata' ? message : `${SCOPE_LABEL[scope]}: ${message}`)
}

export function clearFault(scope: Scope): void {
  if (!faults[scope])
    return
  delete faults[scope]
  if (scope !== 'metadata')
    announce(`${SCOPE_LABEL[scope]} recovered`)
}

/** Why Refresh metadata is unavailable, or `null` while it may run (spec §2.4). */
export function metadataUnavailableReason(): string | null {
  if (app.accountsMode === 'legacy')
    return 'Available after named accounts are enabled'
  if (app.accountsMode === 'unavailable')
    return 'Account management is unavailable for this process'
  return null
}

/** Live on/off (memory only, never persisted). Shared by the toggle and the `l` shortcut. */
export function toggleLive(): void {
  app.live = !app.live
  announce(app.live ? 'Live resumed' : 'Live paused')
}
