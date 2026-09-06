import { describe, expect, test } from 'bun:test'

import {
  compileAccountRouting,
  normalizeDnsHostname,
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
    })
    expect(resolveAccountName(routing, 'localhost')).toBe('default')
    expect(resolveAccountName(routing, '127.0.0.1')).toBe('default')
    expect(resolveAccountName(routing, '127.0.0.2')).toBeUndefined()
    expect(resolveAccountName(routing, 'ACCOUNT1.LOCALHOST.')).toBe('account1')
    expect(resolveAccountName(routing, 'unknown.localhost')).toBeUndefined()
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
