import { describe, expect, test } from 'bun:test'

import { processAnthropicBetaHeader } from '~/transform/beta-headers'

// ── processAnthropicBetaHeader ──
//
// Copilot rejects `context-*` beta values, so the proxy always strips them
// before forwarding. There is no longer any model upgrade tied to the header.

describe('processAnthropicBetaHeader', () => {
  test('strips context-* beta', () => {
    const result = processAnthropicBetaHeader('context-1m-2025-01-01')
    expect(result.header).toBeUndefined()
  })

  test('preserves non-context betas while stripping context-*', () => {
    const result = processAnthropicBetaHeader(
      'context-1m-2025-01-01,max-tokens-3-5-sonnet-2024-07-15',
    )
    expect(result.header).toBe('max-tokens-3-5-sonnet-2024-07-15')
  })

  test('strips mid-conversation system beta before forwarding to Copilot', () => {
    const result = processAnthropicBetaHeader(
      'mid-conversation-system-2026-04-07,max-tokens-3-5-sonnet-2024-07-15',
    )
    expect(result.header).toBe('max-tokens-3-5-sonnet-2024-07-15')
  })

  test('returns undefined header when no betas provided', () => {
    const result = processAnthropicBetaHeader(null)
    expect(result.header).toBeUndefined()
  })
})
