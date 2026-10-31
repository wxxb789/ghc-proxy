/**
 * Credential source for the Microsoft 365 Copilot gateway.
 *
 * The helper (`msc-auth`, see msc-auth/README.md) talks to the Windows token
 * broker and prints `{ access_token, expires_on, tenant, username, scopes }`.
 * Nothing is cached on disk here: the access token lives in memory and is
 * re-acquired before it expires, which is what keeps the login silent.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export interface MscToken {
  accessToken: string
  expiresOn: Date
  tenant: string
}

export interface MscTokenOptions {
  /** Explicit helper path; overrides GHC_MSC_AUTH_EXE and discovery. */
  exe?: string
  /** Broker account (home account id) passed to the helper. */
  account?: string
  /** Account UPN passed to the helper; the helper's own default applies when omitted. */
  upn?: string
  /** Authority tenant passed to the helper. */
  tenant?: string
  timeoutMs?: number
}

export class MscAuthError extends Error {
  readonly code: number

  constructor(message: string, code: number) {
    super(message)
    this.name = 'MscAuthError'
    this.code = code
  }
}

const HELPER_NAME = 'msc-auth.exe'
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const REFRESH_SKEW_MS = 5 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_BUFFER = 1024 * 1024
const NEWLINE_RE = /\r?\n/

let cachedToken: MscToken | undefined
let inflight: Promise<MscToken> | undefined

/** Test hook: drop the in-memory token and any in-flight acquisition. */
export function resetMscTokenCache(): void {
  cachedToken = undefined
  inflight = undefined
}

/**
 * Locates the helper: explicit path, environment override, then the bundled
 * `dist/msc-auth/` payload and the repository build output.
 */
export function resolveMscAuthExe(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.GHC_MSC_AUTH_EXE,
    join(MODULE_DIR, 'msc-auth', HELPER_NAME),
    join(process.cwd(), 'dist', 'msc-auth', HELPER_NAME),
    join(
      process.cwd(),
      'msc-auth',
      'bin',
      'Release',
      'net10.0-windows10.0.19041.0',
      'win-x64',
      HELPER_NAME,
    ),
  ].filter((value): value is string => Boolean(value))

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new MscAuthError(
    `msc-auth helper not found; set GHC_MSC_AUTH_EXE. Tried: ${candidates.join(', ')}`,
    2,
  )
}

interface HelperRun {
  stdout: string
  stderr: string
  code: number
}

export type MscHelperRunner = (
  exe: string,
  args: string[],
  timeoutMs: number,
) => Promise<HelperRun>

function runHelper(exe: string, args: string[], timeoutMs: number): Promise<HelperRun> {
  const { promise, resolve, reject } = Promise.withResolvers<HelperRun>()
  execFile(
    exe,
    args,
    { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_BUFFER },
    (error, stdout, stderr) => {
      const rawCode = (error as { code?: unknown } | null)?.code
      if (error && typeof rawCode !== 'number') {
        reject(new MscAuthError(`msc-auth could not run: ${error.message}`, 2))
        return
      }
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        code: typeof rawCode === 'number' ? rawCode : 0,
      })
    },
  )
  return promise
}

let helperRunner: MscHelperRunner = runHelper

/** Test hook: replace the process-spawning runner; `undefined` restores it. */
export function setMscHelperRunner(runner?: MscHelperRunner): void {
  helperRunner = runner ?? runHelper
}

/** Keeps the diagnostic lines and drops MSAL's informational noise. */
function describeFailure(code: number, stderr: string): string {
  const lines = stderr.split(NEWLINE_RE).map(line => line.trim()).filter(Boolean)
  const own = lines.filter(line => line.startsWith('[msc-auth]'))
  const msal = lines.filter(line => line.startsWith('[msal:Error]'))
  // Prefer the helper's own diagnostics; MSAL lines are the fallback because
  // they describe the broker internals rather than the user-visible cause.
  const detail = (own.length > 0 ? own : msal).slice(-3).join(' | ')
  const hint = code === 2
    ? ' (no broker account matched; run msc-auth --accounts or --interactive once)'
    : code === 3
      ? ' (the selected account could not obtain a gateway token; pick another account)'
      : ''
  return `msc-auth exited ${code}${hint}: ${detail || 'no diagnostics'}`.slice(0, 600)
}

export interface MscAccount {
  upn: string
  homeAccountId: string
  environment: string
}

/**
 * Lists the accounts the Windows token broker exposes. The helper prints
 * `upn<TAB>homeAccountId<TAB>environment` on stdout; diagnostics stay on stderr.
 */
export async function listMscAccounts(
  options: { exe?: string, timeoutMs?: number } = {},
): Promise<MscAccount[]> {
  const exe = resolveMscAuthExe(options.exe)
  const { stdout, stderr, code } = await helperRunner(
    exe,
    ['--accounts'],
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  if (code !== 0) {
    throw new MscAuthError(describeFailure(code, stderr), code)
  }

  return stdout
    .split(NEWLINE_RE)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [upn, homeAccountId, environment] = line.split('\t')
      return { upn: upn ?? '', homeAccountId: homeAccountId ?? '', environment: environment ?? '' }
    })
    .filter(account => account.upn && account.homeAccountId)
}

interface HelperPayload {
  access_token?: unknown
  expires_on?: unknown
  tenant?: unknown
}

async function acquire(options: MscTokenOptions): Promise<MscToken> {
  const exe = resolveMscAuthExe(options.exe)
  const args = ['--json']
  if (options.account) {
    args.push('--account', options.account)
  }
  else if (options.upn) {
    args.push('--upn', options.upn)
  }
  if (options.tenant) {
    args.push('--tenant', options.tenant)
  }

  const { stdout, stderr, code } = await helperRunner(
    exe,
    args,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  if (code !== 0) {
    throw new MscAuthError(describeFailure(code, stderr), code)
  }

  let payload: HelperPayload
  try {
    payload = JSON.parse(stdout) as HelperPayload
  }
  catch {
    throw new MscAuthError(`msc-auth returned non-JSON output: ${stdout.slice(0, 200)}`, 3)
  }

  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''
  const expiresOnRaw = typeof payload.expires_on === 'string' ? payload.expires_on : ''
  const expiresOn = new Date(expiresOnRaw)
  if (!accessToken || Number.isNaN(expiresOn.getTime())) {
    throw new MscAuthError('msc-auth returned no usable access_token/expires_on', 3)
  }

  return {
    accessToken,
    expiresOn,
    tenant: typeof payload.tenant === 'string' ? payload.tenant : '',
  }
}

/**
 * Returns a gateway token, re-acquiring through the helper when it is within
 * five minutes of expiry. Concurrent callers share one acquisition.
 */
export async function getMscToken(options: MscTokenOptions = {}): Promise<MscToken> {
  if (cachedToken && cachedToken.expiresOn.getTime() - Date.now() > REFRESH_SKEW_MS) {
    return cachedToken
  }

  inflight ??= acquire(options)
    .then((token) => {
      cachedToken = token
      return token
    })
    .finally(() => {
      inflight = undefined
    })

  return inflight
}
