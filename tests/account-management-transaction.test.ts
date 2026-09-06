import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import {
  beginAccountManagementTransaction,
  commitAccountManagementTransaction,
  recoverAccountManagementTransaction,
  rollbackAccountManagementTransaction,
} from '~/lib/account-management-transaction'

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghc-proxy-account-management-'))
const paths = {
  CONFIG_PATH: path.join(tempDir, 'config.json'),
  CREDENTIALS_PATH: path.join(tempDir, 'credentials.json'),
  ACCOUNT_MANAGEMENT_JOURNAL_PATH: path.join(tempDir, 'account-management-transaction.json'),
}

describe('account management storage transaction', () => {
  beforeEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('rollback restores both files exactly and removes the journal', async () => {
    const originalConfig = '{\n  "accountRouting": {"defaultAccount":"default"}\n}\n'
    const originalCredentials = '{\n  "version": 1, "activeAccount": "default"\n}\n'
    await fs.writeFile(paths.CONFIG_PATH, originalConfig)
    await fs.writeFile(paths.CREDENTIALS_PATH, originalCredentials)

    await beginAccountManagementTransaction(paths)
    await fs.writeFile(paths.CONFIG_PATH, '{"changed":true}')
    await fs.writeFile(paths.CREDENTIALS_PATH, '{"changed":true}')
    await rollbackAccountManagementTransaction(paths)

    expect(await fs.readFile(paths.CONFIG_PATH, 'utf8')).toBe(originalConfig)
    expect(await fs.readFile(paths.CREDENTIALS_PATH, 'utf8')).toBe(originalCredentials)
    await expect(fs.access(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH)).rejects.toThrow()
  })

  test('startup recovery rolls back an interrupted two-file update', async () => {
    await fs.writeFile(paths.CONFIG_PATH, '{"default":"account1"}')
    await fs.writeFile(paths.CREDENTIALS_PATH, '{"accounts":["account1"]}')
    await beginAccountManagementTransaction(paths)
    await fs.writeFile(paths.CONFIG_PATH, '{"default":"account2"}')
    await fs.writeFile(paths.CREDENTIALS_PATH, '{"accounts":["account1","account2"]}')

    expect(await recoverAccountManagementTransaction(paths)).toBe(true)
    expect(await fs.readFile(paths.CONFIG_PATH, 'utf8')).toBe('{"default":"account1"}')
    expect(await fs.readFile(paths.CREDENTIALS_PATH, 'utf8')).toBe('{"accounts":["account1"]}')
    expect(await recoverAccountManagementTransaction(paths)).toBe(false)
  })

  test('startup recovery rejects a journal owned by a live process', async () => {
    const owner = Bun.spawn([
      process.execPath,
      '--eval',
      'setInterval(() => {}, 1000)',
    ], {
      stderr: 'ignore',
      stdout: 'ignore',
    })
    try {
      await fs.writeFile(paths.CONFIG_PATH, '{"current":true}')
      await fs.writeFile(paths.CREDENTIALS_PATH, '{"current":true}')
      await fs.writeFile(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH, JSON.stringify({
        version: 2,
        owner: {
          pid: owner.pid,
          token: 'different-process-owner',
        },
        config: { exists: true, content: '{"previous":true}' },
        credentials: { exists: true, content: '{"previous":true}' },
      }))

      await expect(recoverAccountManagementTransaction(paths)).rejects.toThrow(
        'owned by live process',
      )
      await expect(commitAccountManagementTransaction(paths)).rejects.toThrow(
        'not owned by this process',
      )
      expect(await fs.readFile(paths.CONFIG_PATH, 'utf8')).toBe('{"current":true}')
      expect(await fs.readFile(paths.CREDENTIALS_PATH, 'utf8')).toBe('{"current":true}')
      expect(await fs.readFile(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH, 'utf8')).toContain(
        'different-process-owner',
      )
    }
    finally {
      owner.kill()
      await owner.exited
    }
  })

  test('startup recovery rolls back a journal whose owner exited', async () => {
    const owner = Bun.spawn([process.execPath, '--eval', ''], {
      stderr: 'ignore',
      stdout: 'ignore',
    })
    await owner.exited

    await fs.writeFile(paths.CONFIG_PATH, '{"current":true}')
    await fs.writeFile(paths.CREDENTIALS_PATH, '{"current":true}')
    await fs.writeFile(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH, JSON.stringify({
      version: 2,
      owner: {
        pid: owner.pid,
        token: 'abandoned-owner',
      },
      config: { exists: true, content: '{"previous":true}' },
      credentials: { exists: true, content: '{"previous":true}' },
    }))

    expect(await recoverAccountManagementTransaction(paths)).toBe(true)
    expect(await fs.readFile(paths.CONFIG_PATH, 'utf8')).toBe('{"previous":true}')
    expect(await fs.readFile(paths.CREDENTIALS_PATH, 'utf8')).toBe('{"previous":true}')
    await expect(fs.access(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH)).rejects.toThrow()
  })

  test('startup recovery preserves support for a legacy journal', async () => {
    await fs.writeFile(paths.CONFIG_PATH, '{"current":true}')
    await fs.writeFile(paths.CREDENTIALS_PATH, '{"current":true}')
    await fs.writeFile(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH, JSON.stringify({
      version: 1,
      config: { exists: true, content: '{"previous":true}' },
      credentials: { exists: true, content: '{"previous":true}' },
    }))

    expect(await recoverAccountManagementTransaction(paths)).toBe(true)
    expect(await fs.readFile(paths.CONFIG_PATH, 'utf8')).toBe('{"previous":true}')
    expect(await fs.readFile(paths.CREDENTIALS_PATH, 'utf8')).toBe('{"previous":true}')
    await expect(fs.access(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH)).rejects.toThrow()
  })

  test('commit keeps both new files and removes the journal', async () => {
    await fs.writeFile(paths.CONFIG_PATH, '{"default":"account1"}')
    await fs.writeFile(paths.CREDENTIALS_PATH, '{"accounts":["account1"]}')
    await beginAccountManagementTransaction(paths)
    await fs.writeFile(paths.CONFIG_PATH, '{"default":"account2"}')
    await fs.writeFile(paths.CREDENTIALS_PATH, '{"accounts":["account1","account2"]}')

    await commitAccountManagementTransaction(paths)

    expect(await fs.readFile(paths.CONFIG_PATH, 'utf8')).toBe('{"default":"account2"}')
    expect(await fs.readFile(paths.CREDENTIALS_PATH, 'utf8')).toBe('{"accounts":["account1","account2"]}')
    await expect(fs.access(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH)).rejects.toThrow()
  })

  test('rollback removes files that did not exist before the transaction', async () => {
    await beginAccountManagementTransaction(paths)
    await fs.writeFile(paths.CONFIG_PATH, '{}')
    await fs.writeFile(paths.CREDENTIALS_PATH, '{}')

    await rollbackAccountManagementTransaction(paths)

    await expect(fs.access(paths.CONFIG_PATH)).rejects.toThrow()
    await expect(fs.access(paths.CREDENTIALS_PATH)).rejects.toThrow()
  })

  test('malformed journal fails closed without changing managed files', async () => {
    await fs.writeFile(paths.CONFIG_PATH, '{"current":true}')
    await fs.writeFile(paths.CREDENTIALS_PATH, '{"current":true}')
    await fs.writeFile(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH, '{"broken":true}')

    await expect(recoverAccountManagementTransaction(paths)).rejects.toThrow(
      'account management transaction journal',
    )
    expect(await fs.readFile(paths.CONFIG_PATH, 'utf8')).toBe('{"current":true}')
    expect(await fs.readFile(paths.CREDENTIALS_PATH, 'utf8')).toBe('{"current":true}')
  })

  test('does not overwrite an unresolved transaction journal', async () => {
    await fs.writeFile(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH, JSON.stringify({
      version: 1,
      config: { exists: false },
      credentials: { exists: false },
    }))

    await expect(beginAccountManagementTransaction(paths)).rejects.toThrow(
      'unfinished account management transaction',
    )
  })
})
