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
  username?: string
  homeAccountId?: string
  environment?: string
}

export interface MscTokenOptions {
  /** Explicit helper path; overrides GHC_MSC_AUTH_EXE and discovery. */
  exe?: string
  /** Broker home account id or exact account email passed to the helper. */
  account?: string
  /** Exact account UPN passed to the helper. */
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
const TRAILING_CR_RE = /\r$/

const cachedTokens = new Map<string, MscToken>()
const inflightTokens = new Map<string, Promise<MscToken>>()
let cacheGeneration = 0

export function resetMscTokenCache(): void {
  cachedTokens.clear()
  inflightTokens.clear()
  cacheGeneration += 1
}

function credentialKey(options: MscTokenOptions): string {
  return JSON.stringify([options.exe ?? '', options.account ?? '', options.upn ?? '', options.tenant ?? ''])
}

/**
 * Locates the helper: explicit path, environment override, then the bundled
 * `dist/msc-auth/` payload and the repository build output.
 */
export function resolveMscAuthExe(explicit?: string): string {
  const override = explicit ?? process.env.GHC_MSC_AUTH_EXE
  if (override) {
    if (existsSync(override))
      return override
    throw new MscAuthError(`msc-auth helper override not found: ${override}`, 2)
  }
  const candidates = [
    join(MODULE_DIR, 'msc-auth', HELPER_NAME),
    join(MODULE_DIR, '..', '..', 'dist', 'msc-auth', HELPER_NAME),
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
  ]

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
        stdout,
        stderr,
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
    .map(line => line.replace(TRAILING_CR_RE, ''))
    .filter(Boolean)
    .map((line) => {
      const [upn, homeAccountId, environment] = line.split('\t')
      return { upn: upn ?? '', homeAccountId: homeAccountId ?? '', environment: environment ?? '' }
    })
    .filter(account => account.homeAccountId)
}

interface HelperPayload {
  access_token?: unknown
  expires_on?: unknown
  tenant?: unknown
  username?: unknown
  home_account_id?: unknown
  environment?: unknown
}

async function acquire(options: MscTokenOptions, interactive = false): Promise<MscToken> {
  const exe = resolveMscAuthExe(options.exe)
  const args = ['--json']
  if (interactive) {
    args.push('--interactive')
  }
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
    throw new MscAuthError('msc-auth returned non-JSON output; rebuild or update the helper.', 3)
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
    username: typeof payload.username === 'string' ? payload.username : undefined,
    homeAccountId: typeof payload.home_account_id === 'string' ? payload.home_account_id : undefined,
    environment: typeof payload.environment === 'string' ? payload.environment : undefined,
  }
}

/** Opens WAM only on an explicit Dashboard sign-in action; never returns a token. */
export async function signInMscAccount(options: { exe?: string, upn?: string } = {}): Promise<MscAccount> {
  const token = await acquire({ ...options, timeoutMs: 120_000 }, true)
  if (!token.homeAccountId) {
    throw new MscAuthError('msc-auth returned no broker account identity; rebuild or update the helper.', 3)
  }
  resetMscTokenCache()
  return {
    upn: token.username ?? '',
    homeAccountId: token.homeAccountId,
    environment: token.environment ?? '',
  }
}

function startAcquisition(key: string, options: MscTokenOptions): Promise<MscToken> {
  const generation = cacheGeneration
  const promise = acquire(options).then((token) => {
    if (generation === cacheGeneration) {
      cachedTokens.set(key, token)
    }
    return token
  })
  inflightTokens.set(key, promise)
  const clear = () => {
    if (inflightTokens.get(key) === promise) {
      inflightTokens.delete(key)
    }
  }
  void promise.then(clear, clear)
  return promise
}

/**
 * Returns a gateway token, re-acquiring through the helper when it is within
 * five minutes of expiry. Concurrent callers with the same credential identity
 * share one acquisition.
 */
export async function getMscToken(options: MscTokenOptions = {}): Promise<MscToken> {
  const key = credentialKey(options)
  const cached = cachedTokens.get(key)
  if (cached && cached.expiresOn.getTime() - Date.now() > REFRESH_SKEW_MS) {
    return cached
  }

  return inflightTokens.get(key) ?? startAcquisition(key, options)
}
