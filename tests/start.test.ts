import { describe, expect, test } from 'bun:test'

import { resolveDumpFailedPayloadsOption } from '../src/start'

describe('start options', () => {
  test('dump failed payloads is enabled by the CLI flag', () => {
    expect(resolveDumpFailedPayloadsOption(true, undefined)).toBe(true)
    expect(resolveDumpFailedPayloadsOption(true, '0')).toBe(true)
  })

  test('dump failed payloads can be enabled by environment variable', () => {
    expect(resolveDumpFailedPayloadsOption(false, '1')).toBe(true)
    expect(resolveDumpFailedPayloadsOption(false, 'true')).toBe(true)
    expect(resolveDumpFailedPayloadsOption(false, 'TRUE')).toBe(true)
  })

  test('dump failed payloads stays disabled for absent or non-truthy environment values', () => {
    expect(resolveDumpFailedPayloadsOption(false, undefined)).toBe(false)
    expect(resolveDumpFailedPayloadsOption(false, '')).toBe(false)
    expect(resolveDumpFailedPayloadsOption(false, '0')).toBe(false)
    expect(resolveDumpFailedPayloadsOption(false, 'false')).toBe(false)
    expect(resolveDumpFailedPayloadsOption(false, 'yes')).toBe(false)
  })
})
