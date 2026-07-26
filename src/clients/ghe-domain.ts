import { GITHUB_API_BASE_URL, GITHUB_BASE_URL } from './api-config'

const GHE_SUFFIX = '.ghe.com'

/**
 * Normalize a GHE domain input to a lowercase bare domain.
 *
 * Accepted inputs: `company.ghe.com`, `https://company.ghe.com`,
 * `https://Company.GHE.com/`, etc.
 *
 * @returns Bare lowercase domain, e.g. `company.ghe.com`
 * @throws {Error} If the input is empty or does not end with `.ghe.com`
 */
export function normalizeGheDomain(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('GHE domain must not be empty')
  }

  let domain: string
  try {
    // If it looks like a URL (has ://), parse it; otherwise treat as bare domain
    const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`)
    domain = url.hostname.toLowerCase()
  }
  catch {
    throw new Error(`Invalid GHE domain: ${trimmed}`)
  }

  if (!domain.endsWith(GHE_SUFFIX) || domain === GHE_SUFFIX.slice(1)) {
    throw new Error(`GHE domain must end with ${GHE_SUFFIX} (got "${domain}")`)
  }

  return domain
}

/** The `authStore` fields this resolution reads and writes. */
export interface GheDomainTarget {
  gheDomain?: string
  accountType: 'individual' | 'business' | 'enterprise'
}

/**
 * Resolve the effective GHE domain onto `authStore` and promote the account
 * type when one is in play.
 *
 * Every entry point (`start`, `auth`, `check-usage`) needs both halves: the
 * domain selects the GitHub URLs, while `accountType` selects the Copilot base
 * URL in `copilotBaseUrl()`. Applying only the first sends GHE users to the
 * public Copilot endpoint, so the two are resolved together here rather than
 * re-derived per command.
 *
 * @param auth Mutated in place — receives the resolved domain and, when a
 * domain is in play, an account type promoted from `individual`.
 * @param configuredDomain Persisted `gheDomain` from config.json.
 * @param overrideDomain CLI argument. `undefined` leaves the persisted value
 * alone; an empty string explicitly clears it.
 */
export function applyGheDomain(
  auth: GheDomainTarget,
  configuredDomain: string | undefined,
  overrideDomain?: string,
): void {
  auth.gheDomain = configuredDomain

  if (overrideDomain !== undefined) {
    auth.gheDomain = overrideDomain ? normalizeGheDomain(overrideDomain) : undefined
  }

  if (auth.gheDomain && auth.accountType === 'individual') {
    auth.accountType = 'enterprise'
  }
}

/**
 * Build GitHub base URL and API base URL for a given GHE domain,
 * or return the public GitHub defaults when no domain is provided.
 */
export function buildGitHubUrls(gheDomain?: string): { baseUrl: string, apiBaseUrl: string } {
  if (!gheDomain) {
    return { baseUrl: GITHUB_BASE_URL, apiBaseUrl: GITHUB_API_BASE_URL }
  }

  const domain = normalizeGheDomain(gheDomain)
  return {
    baseUrl: `https://${domain}`,
    apiBaseUrl: `https://api.${domain}`,
  }
}
