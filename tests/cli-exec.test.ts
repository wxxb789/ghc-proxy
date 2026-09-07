import { describe, expect, test } from 'bun:test'

import { includesTextIgnoringLineEndings } from '../scripts/lib/cli-exec'

describe('CLI text helpers', () => {
  test('matches embedded text across CRLF and LF checkouts', () => {
    const notice = '# Notices\r\n\r\nMIT License\r\nCopyright holder\r\n'
    const license = 'MIT License\nCopyright holder\n'

    expect(includesTextIgnoringLineEndings(notice, license)).toBe(true)
  })
})
