import { describe, expect, test } from 'bun:test'

import { buildGitHubUrls, normalizeGheDomain } from '../src/clients/ghe-domain'

describe('normalizeGheDomain', () => {
  test('bare domain passes through unchanged', () => {
    expect(normalizeGheDomain('company.ghe.com')).toBe('company.ghe.com')
  })

  test('strips https:// prefix', () => {
    expect(normalizeGheDomain('https://company.ghe.com')).toBe('company.ghe.com')
  })

  test('strips https:// prefix, lowercases, and removes trailing slash', () => {
    expect(normalizeGheDomain('https://Company.GHE.com/')).toBe('company.ghe.com')
  })

  test('strips http:// prefix', () => {
    expect(normalizeGheDomain('http://company.ghe.com')).toBe('company.ghe.com')
  })

  test('strips trailing slashes and paths', () => {
    expect(normalizeGheDomain('https://company.ghe.com/some/path')).toBe('company.ghe.com')
  })

  test('handles deep subdomains', () => {
    expect(normalizeGheDomain('dev.internal.ghe.com')).toBe('dev.internal.ghe.com')
  })

  test('rejects non-.ghe.com domains', () => {
    expect(() => normalizeGheDomain('github.example.com')).toThrow('must end with .ghe.com')
  })

  test('rejects bare ghe.com without subdomain', () => {
    expect(() => normalizeGheDomain('ghe.com')).toThrow('must end with .ghe.com')
  })

  test('rejects empty string', () => {
    expect(() => normalizeGheDomain('')).toThrow('GHE domain must not be empty')
  })

  test('rejects whitespace-only string', () => {
    expect(() => normalizeGheDomain('   ')).toThrow('GHE domain must not be empty')
  })
})

describe('buildGitHubUrls', () => {
  test('no domain returns default GitHub URLs', () => {
    expect(buildGitHubUrls()).toEqual({
      baseUrl: 'https://github.com',
      apiBaseUrl: 'https://api.github.com',
    })
  })

  test('undefined domain returns default GitHub URLs', () => {
    expect(buildGitHubUrls(undefined)).toEqual({
      baseUrl: 'https://github.com',
      apiBaseUrl: 'https://api.github.com',
    })
  })

  test('GHE domain returns GHE URLs', () => {
    expect(buildGitHubUrls('company.ghe.com')).toEqual({
      baseUrl: 'https://company.ghe.com',
      apiBaseUrl: 'https://api.company.ghe.com',
    })
  })

  test('GHE domain with deep subdomain returns correct URLs', () => {
    expect(buildGitHubUrls('dev.internal.ghe.com')).toEqual({
      baseUrl: 'https://dev.internal.ghe.com',
      apiBaseUrl: 'https://api.dev.internal.ghe.com',
    })
  })

  test('GHE domain input is normalized before building URLs', () => {
    expect(buildGitHubUrls('https://Company.GHE.com/')).toEqual({
      baseUrl: 'https://company.ghe.com',
      apiBaseUrl: 'https://api.company.ghe.com',
    })
  })

  test('invalid domain propagates normalizeGheDomain error', () => {
    expect(() => buildGitHubUrls('github.example.com')).toThrow('must end with .ghe.com')
  })
})
