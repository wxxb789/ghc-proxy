import { CONTEXT_BETA_RE } from './constants'

const COPILOT_UNSUPPORTED_BETA_RE = /^mid-conversation-system-\d{4}-\d{2}-\d{2}$/

export interface BetaHeaderResult {
  header: string | undefined
}

export function processAnthropicBetaHeader(
  rawHeader: string | null,
): BetaHeaderResult {
  if (!rawHeader)
    return { header: undefined }

  const values = rawHeader.split(',').map(v => v.trim()).filter(Boolean)
  const filtered: string[] = []

  for (const value of values) {
    // Strip context-* betas — Copilot doesn't understand them.
    if (CONTEXT_BETA_RE.test(value)) {
      continue
    }
    if (COPILOT_UNSUPPORTED_BETA_RE.test(value)) {
      continue
    }
    filtered.push(value)
  }

  return {
    header: filtered.length > 0 ? filtered.join(',') : undefined,
  }
}
