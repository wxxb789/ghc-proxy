import { describe, expect, test } from 'bun:test'

import {
  compileAccountRouting,
  normalizeDnsHostname,
  rebaseAccountRoutingUpdate,
  resolveAccountName,
} from '~/lib/account-routing'

describe('account routing contract', () => {
  test('routes the base hostname to the explicit default account', () => {
    const routing = compileAccountRouting({
      baseHostname: 'LOCALHOST.',
      defaultAccount: 'default',
      hostnames: {
        'Default.Localhost.': 'default',
        'Account1.Localhost.': 'account1',
      },
    }, ['default', 'account1'])

    expect(routing).toEqual({
      baseHostname: 'localhost',
      defaultAccount: 'default',
      hostnames: new Map([
        ['default.localhost', 'default'],
        ['account1.localhost', 'account1'],
      ]),
      kinds: new Map([
        ['default', 'github'],
        ['account1', 'github'],
      ]),
    })
    expect(resolveAccountName(routing, 'localhost')).toBe('default')
    expect(resolveAccountName(routing, '127.0.0.1')).toBe('default')
    expect(resolveAccountName(routing, '127.0.0.2')).toBeUndefined()
    expect(resolveAccountName(routing, 'ACCOUNT1.LOCALHOST.')).toBe('account1')
    expect(resolveAccountName(routing, 'unknown.localhost')).toBeUndefined()
  })

  test('admits the reserved M365 target without a credential', () => {
    const routing = compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'default',
      hostnames: {
        'default.localhost': 'default',
        'account1.localhost': 'account1',
        'm365.localhost': 'm365',
      },
    }, ['default', 'account1'])

    expect(routing.kinds.get('m365')).toBe('m365')
    expect(routing.kinds.get('default')).toBe('github')
    expect(resolveAccountName(routing, 'm365.localhost')).toBe('m365')
  })

  test('rejects a GitHub credential named after the reserved target', () => {
    expect(() => compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'm365',
      hostnames: { 'm365.localhost': 'm365' },
    }, ['m365'])).toThrow('reserved')
  })

  test('does not create an M365 target without a hostname mapping', () => {
    const routing = compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'default',
      hostnames: { 'default.localhost': 'default' },
    }, ['default'])

    expect(routing.kinds.has('m365')).toBe(false)
  })

  test('rejects ambiguous or incomplete routing configuration', () => {
    expect(() => compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'missing',
      hostnames: {},
    }, ['default'])).toThrow('default account "missing"')

    expect(() => compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'default',
      hostnames: {
        'Account1.Localhost': 'account1',
        'account1.localhost.': 'account1',
      },
    }, ['default', 'account1'])).toThrow('same DNS hostname')

    expect(() => compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'default',
      hostnames: {
        'account1.localhost': 'missing',
      },
    }, ['default'])).toThrow('missing account "missing"')

    expect(() => compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'default account',
      hostnames: {},
    }, ['default account'])).toThrow('Expected an account name')

    expect(() => compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'default',
      hostnames: {
        'account1.localhost': 'account1',
      },
    }, ['default', 'account1'])).toThrow(
      'exactly one dedicated hostname for account "default"',
    )

    expect(() => compileAccountRouting({
      baseHostname: 'localhost',
      defaultAccount: 'default',
      hostnames: {
        'default.localhost': 'default',
        'default-alt.localhost': 'default',
      },
    }, ['default'])).toThrow(
      'exactly one dedicated hostname for account "default"',
    )
  })

  test.each([
    ['localhost', 'localhost'],
    ['LOCALHOST.', 'localhost'],
    ['account1.localhost', 'account1.localhost'],
  ])('normalizes DNS hostname %s', (input, expected) => {
    expect(normalizeDnsHostname(input)).toBe(expected)
  })

  test.each([
    '',
    'localhost:4141',
    'https://localhost',
    'bad host',
    '127.0.0.1',
    '::1',
  ])('rejects non-DNS hostname %s', (input) => {
    expect(() => normalizeDnsHostname(input)).toThrow('DNS hostname')
  })
})

describe('rebasing a routing change onto the stored routing', () => {
  const routing = (hostnames: Record<string, string>, defaultAccount = 'default') => ({
    baseHostname: 'localhost',
    defaultAccount,
    hostnames: { 'default.localhost': 'default', ...hostnames },
  })

  test('applies only this change and keeps entries saved by another process', () => {
    expect(rebaseAccountRoutingUpdate(
      routing({ 'm365.localhost': 'm365', 'old.localhost': 'gh1' }),
      { previous: routing({ 'old.localhost': 'gh1' }), next: routing({ 'new.localhost': 'gh1' }, 'gh1') },
    )).toEqual(routing({ 'm365.localhost': 'm365', 'new.localhost': 'gh1' }, 'gh1'))
  })

  test('drops every stored hostname of a removed target', () => {
    expect(rebaseAccountRoutingUpdate(
      routing({ 'gh1.localhost': 'gh1', 'alias.localhost': 'gh1', 'm365.localhost': 'm365' }),
      { previous: routing({ 'gh1.localhost': 'gh1' }), next: routing({}) },
    )).toEqual(routing({ 'm365.localhost': 'm365' }))
  })

  for (const { name, stored, previous, next } of [
    {
      name: 'binding a hostname another process bound to a different target',
      stored: routing({ 'shared.localhost': 'gh3' }),
      previous: routing({}),
      next: routing({ 'shared.localhost': 'gh2' }),
    },
    {
      name: 'dropping a hostname another process rebound',
      stored: routing({ 'm365.localhost': 'gh3' }),
      previous: routing({ 'm365.localhost': 'm365' }),
      next: routing({}),
    },
  ]) {
    test(`refuses ${name}`, () => {
      expect(() => rebaseAccountRoutingUpdate(stored, { previous, next })).toThrow('changed')
    })
  }
})
