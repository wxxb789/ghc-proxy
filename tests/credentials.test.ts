import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

import {
  finalizeGitHubCredentialMigration,
  prepareGitHubCredential,
  readGitHubCredential,
  replaceGitHubCredentialDuringMigration,
  writeGitHubCredential,
} from '../src/lib/credentials'

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghc-proxy-credentials-'))
const credentialPaths = {
  CONFIG_PATH: path.join(tempDir, 'config.json'),
  CREDENTIALS_PATH: path.join(tempDir, 'credentials.json'),
  CONFIG_MIGRATION_BACKUP_PATH: path.join(tempDir, 'config.json.github-token-migration.bak'),
}
const journalPath = `${credentialPaths.CONFIG_MIGRATION_BACKUP_PATH}.replacement.json`

function migrationJournal(legacyToken: string, replacementToken: string) {
  return JSON.stringify({
    version: 1,
    legacyTokenDigest: tokenDigest(legacyToken),
    replacementTokenDigest: tokenDigest(replacementToken),
  })
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

describe('credential store', () => {
  beforeEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('writes a versioned Base64 credential without persisting the raw token', async () => {
    await writeGitHubCredential('github-secret', 'corp.ghe.com', credentialPaths)

    const content = await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')
    const stored = JSON.parse(content) as {
      version: number
      activeAccount: string
      accounts: Record<string, { githubToken: string, gheDomain?: string }>
    }

    expect(content).not.toContain('github-secret')
    expect(stored.version).toBe(1)
    expect(stored.activeAccount).toBe('default')
    expect(Buffer.from(stored.accounts.default!.githubToken, 'base64').toString('utf8')).toBe('github-secret')
    expect(stored.accounts.default!.gheDomain).toBe('corp.ghe.com')
    expect(await readGitHubCredential(credentialPaths)).toEqual({
      accountName: 'default',
      githubToken: 'github-secret',
      gheDomain: 'corp.ghe.com',
    })
  })

  test('reads the active named account and preserves sibling accounts on write', async () => {
    await fs.writeFile(credentialPaths.CREDENTIALS_PATH, JSON.stringify({
      version: 1,
      activeAccount: 'work',
      accounts: {
        personal: { githubToken: Buffer.from('personal-token').toString('base64') },
        work: {
          githubToken: Buffer.from('old-work-token').toString('base64'),
          gheDomain: 'corp.ghe.com',
        },
      },
    }))

    expect(await readGitHubCredential(credentialPaths)).toEqual({
      accountName: 'work',
      githubToken: 'old-work-token',
      gheDomain: 'corp.ghe.com',
    })

    await writeGitHubCredential('new-work-token', 'corp.ghe.com', credentialPaths)

    const stored = JSON.parse(await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')) as {
      accounts: Record<string, { githubToken: string }>
    }
    expect(Buffer.from(stored.accounts.personal!.githubToken, 'base64').toString('utf8')).toBe('personal-token')
    expect(Buffer.from(stored.accounts.work!.githubToken, 'base64').toString('utf8')).toBe('new-work-token')
  })

  test('stages a legacy token with an exact config backup and leaves config untouched', async () => {
    const legacyConfig = '{\n  "githubToken": "legacy-token",\n  "smallModel": "gpt-5-mini"\n}\n'
    await fs.writeFile(credentialPaths.CONFIG_PATH, legacyConfig)

    const prepared = await prepareGitHubCredential(credentialPaths)

    expect(prepared).toEqual({
      accountName: 'default',
      githubToken: 'legacy-token',
      migrationPending: true,
      gheDomain: undefined,
    })
    expect(await fs.readFile(credentialPaths.CONFIG_PATH, 'utf8')).toBe(legacyConfig)
    expect(await fs.readFile(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')).toBe(legacyConfig)
    expect(await readGitHubCredential(credentialPaths)).toMatchObject({ githubToken: 'legacy-token' })
  })

  test('refuses first staging when an active credential already differs from legacy config', async () => {
    const legacyConfig = JSON.stringify({ githubToken: 'legacy-token', smallModel: 'gpt-5-mini' })
    await fs.writeFile(credentialPaths.CONFIG_PATH, legacyConfig)
    await writeGitHubCredential('existing-token', 'corp.ghe.com', credentialPaths)
    const existingCredentials = await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')

    await expect(prepareGitHubCredential(credentialPaths)).rejects.toThrow('does not match the migration backup')

    expect(await fs.readFile(credentialPaths.CONFIG_PATH, 'utf8')).toBe(legacyConfig)
    expect(await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')).toBe(existingCredentials)
    expect(await fs.readFile(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')).toBe(legacyConfig)
  })

  test('finalizes migration by preserving config fields and deleting the backup last', async () => {
    await fs.writeFile(credentialPaths.CONFIG_PATH, JSON.stringify({
      githubToken: 'legacy-token',
      gheDomain: 'corp.ghe.com',
      smallModel: 'gpt-5-mini',
    }))
    await prepareGitHubCredential(credentialPaths)

    expect(await finalizeGitHubCredentialMigration('legacy-token', credentialPaths)).toBe(true)

    expect(JSON.parse(await fs.readFile(credentialPaths.CONFIG_PATH, 'utf8'))).toEqual({
      gheDomain: 'corp.ghe.com',
      smallModel: 'gpt-5-mini',
    })
    await expect(fs.access(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
  })

  test('commits a verified replacement only from matching pending migration state', async () => {
    await fs.writeFile(credentialPaths.CONFIG_PATH, JSON.stringify({
      githubToken: 'legacy-token',
      gheDomain: 'old.ghe.com',
      smallModel: 'gpt-5-mini',
    }))
    await prepareGitHubCredential(credentialPaths)

    await replaceGitHubCredentialDuringMigration(
      'legacy-token',
      'replacement-token',
      undefined,
      credentialPaths,
    )

    expect(await readGitHubCredential(credentialPaths)).toEqual({
      accountName: 'default',
      githubToken: 'replacement-token',
      gheDomain: undefined,
    })
    expect(JSON.parse(await fs.readFile(credentialPaths.CONFIG_PATH, 'utf8'))).toEqual({
      smallModel: 'gpt-5-mini',
    })
    await expect(fs.access(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
    await expect(fs.access(journalPath)).rejects.toThrow()
  })

  test('refuses a replacement when the pending credential no longer matches legacy state', async () => {
    const legacyConfig = JSON.stringify({ githubToken: 'legacy-token', smallModel: 'gpt-5-mini' })
    await fs.writeFile(credentialPaths.CONFIG_PATH, legacyConfig)
    await prepareGitHubCredential(credentialPaths)
    await writeGitHubCredential('newer-token', undefined, credentialPaths)

    const driftedCredentials = await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')
    const backup = await fs.readFile(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')

    await expect(
      replaceGitHubCredentialDuringMigration(
        'legacy-token',
        'replacement-token',
        undefined,
        credentialPaths,
      ),
    ).rejects.toThrow('does not match the expected legacy GitHub token')

    expect(await fs.readFile(credentialPaths.CONFIG_PATH, 'utf8')).toBe(legacyConfig)
    expect(await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')).toBe(driftedCredentials)
    expect(await fs.readFile(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')).toBe(backup)
  })

  test('refuses a replacement when config contains a different legacy token', async () => {
    const legacyConfig = JSON.stringify({ githubToken: 'legacy-token', smallModel: 'gpt-5-mini' })
    await fs.writeFile(credentialPaths.CONFIG_PATH, legacyConfig)
    await prepareGitHubCredential(credentialPaths)
    await fs.writeFile(credentialPaths.CONFIG_PATH, JSON.stringify({
      githubToken: 'other-token',
      smallModel: 'gpt-5-mini',
    }))

    const driftedConfig = await fs.readFile(credentialPaths.CONFIG_PATH, 'utf8')
    const credentials = await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')
    const backup = await fs.readFile(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')

    await expect(
      replaceGitHubCredentialDuringMigration(
        'legacy-token',
        'replacement-token',
        undefined,
        credentialPaths,
      ),
    ).rejects.toThrow('contains a different legacy GitHub token')

    expect(await fs.readFile(credentialPaths.CONFIG_PATH, 'utf8')).toBe(driftedConfig)
    expect(await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')).toBe(credentials)
    expect(await fs.readFile(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')).toBe(backup)
  })

  test('restarts a pending migration idempotently without duplicating or rewriting credentials', async () => {
    const legacyConfig = JSON.stringify({ githubToken: 'legacy-token', gheDomain: 'corp.ghe.com' })
    await fs.writeFile(credentialPaths.CONFIG_PATH, legacyConfig)

    await prepareGitHubCredential(credentialPaths)
    const firstCredentials = await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')
    const firstBackup = await fs.readFile(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')

    const prepared = await prepareGitHubCredential(credentialPaths)

    expect(prepared?.migrationPending).toBe(true)
    expect(await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')).toBe(firstCredentials)
    expect(await fs.readFile(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')).toBe(firstBackup)
  })

  test('rejects a divergent pending migration without losing the original credential', async () => {
    const legacyConfig = JSON.stringify({ githubToken: 'legacy-token', smallModel: 'gpt-5-mini' })
    await fs.writeFile(credentialPaths.CONFIG_PATH, legacyConfig)
    await prepareGitHubCredential(credentialPaths)
    await writeGitHubCredential('newer-token', undefined, credentialPaths)

    const driftedCredentials = await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')
    const backup = await fs.readFile(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')

    await expect(prepareGitHubCredential(credentialPaths)).rejects.toThrow('does not match the migration backup')
    await expect(
      finalizeGitHubCredentialMigration('newer-token', credentialPaths),
    ).rejects.toThrow('must match before finalizing')

    expect(await fs.readFile(credentialPaths.CONFIG_PATH, 'utf8')).toBe(legacyConfig)
    expect(await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')).toBe(driftedCredentials)
    expect(await fs.readFile(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')).toBe(backup)
  })

  test('resumes a replacement split state and finalizes it after validating the replacement token', async () => {
    const legacyConfig = JSON.stringify({
      githubToken: 'legacy-token',
      gheDomain: 'old.ghe.com',
      smallModel: 'gpt-5-mini',
    })
    await fs.writeFile(credentialPaths.CONFIG_PATH, legacyConfig)
    await prepareGitHubCredential(credentialPaths)
    await fs.writeFile(journalPath, migrationJournal('legacy-token', 'replacement-token'))
    await writeGitHubCredential('replacement-token', 'new.ghe.com', credentialPaths)

    expect(await prepareGitHubCredential(credentialPaths)).toEqual({
      accountName: 'default',
      githubToken: 'replacement-token',
      migrationPending: true,
      replacementPending: true,
      gheDomain: 'new.ghe.com',
    })
    expect(await finalizeGitHubCredentialMigration('replacement-token', credentialPaths)).toBe(true)
    expect(await readGitHubCredential(credentialPaths)).toMatchObject({ githubToken: 'replacement-token' })
    expect(JSON.parse(await fs.readFile(credentialPaths.CONFIG_PATH, 'utf8'))).toEqual({
      gheDomain: 'new.ghe.com',
      smallModel: 'gpt-5-mini',
    })
    await expect(fs.access(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH)).rejects.toThrow()
    await expect(fs.access(journalPath)).rejects.toThrow()
  })

  test('discards a journal written before the replacement store and resumes the legacy credential', async () => {
    const legacyConfig = JSON.stringify({ githubToken: 'legacy-token' })
    await fs.writeFile(credentialPaths.CONFIG_PATH, legacyConfig)
    await prepareGitHubCredential(credentialPaths)
    const journal = migrationJournal('legacy-token', 'replacement-token')
    await fs.writeFile(journalPath, journal)

    expect(journal).not.toContain('legacy-token')
    expect(journal).not.toContain('replacement-token')
    expect(await prepareGitHubCredential(credentialPaths)).toEqual({
      accountName: 'default',
      githubToken: 'legacy-token',
      migrationPending: true,
      gheDomain: undefined,
    })
    await expect(fs.access(journalPath)).rejects.toThrow()
    expect(await fs.readFile(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')).toBe(legacyConfig)
  })

  test('rejects a malformed replacement journal without changing recovery files', async () => {
    const legacyConfig = JSON.stringify({ githubToken: 'legacy-token' })
    await fs.writeFile(credentialPaths.CONFIG_PATH, legacyConfig)
    await prepareGitHubCredential(credentialPaths)
    await fs.writeFile(journalPath, '{ invalid journal')
    const credentials = await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')

    await expect(prepareGitHubCredential(credentialPaths)).rejects.toThrow('transaction journal')
    expect(await fs.readFile(credentialPaths.CONFIG_PATH, 'utf8')).toBe(legacyConfig)
    expect(await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')).toBe(credentials)
    expect(await fs.readFile(journalPath, 'utf8')).toBe('{ invalid journal')
  })

  test('rejects a replacement journal whose legacy digest does not match the backup', async () => {
    const legacyConfig = JSON.stringify({ githubToken: 'legacy-token' })
    await fs.writeFile(credentialPaths.CONFIG_PATH, legacyConfig)
    await prepareGitHubCredential(credentialPaths)
    const journal = migrationJournal('other-legacy-token', 'replacement-token')
    await fs.writeFile(journalPath, journal)
    const credentials = await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')

    await expect(prepareGitHubCredential(credentialPaths)).rejects.toThrow('does not match the migration backup')
    expect(await fs.readFile(credentialPaths.CONFIG_PATH, 'utf8')).toBe(legacyConfig)
    expect(await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')).toBe(credentials)
    expect(await fs.readFile(journalPath, 'utf8')).toBe(journal)
  })

  test('removes a stale journal after the migration backup has already been deleted', async () => {
    await writeGitHubCredential('replacement-token', undefined, credentialPaths)
    await fs.writeFile(journalPath, migrationJournal('legacy-token', 'replacement-token'))

    expect(await finalizeGitHubCredentialMigration('replacement-token', credentialPaths)).toBe(false)
    expect(await readGitHubCredential(credentialPaths)).toMatchObject({ githubToken: 'replacement-token' })
    await expect(fs.access(journalPath)).rejects.toThrow()
  })

  test('does not revive a legacy token when staging races an explicit credential write', async () => {
    const legacyConfig = JSON.stringify({ githubToken: 'legacy-token' })
    await fs.writeFile(credentialPaths.CONFIG_PATH, legacyConfig)

    await Promise.allSettled([
      prepareGitHubCredential(credentialPaths),
      writeGitHubCredential('explicit-token', undefined, credentialPaths),
    ])

    expect(await readGitHubCredential(credentialPaths)).toMatchObject({ githubToken: 'explicit-token' })
    expect(await fs.readFile(credentialPaths.CONFIG_PATH, 'utf8')).toBe(legacyConfig)
    expect(await fs.readFile(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')).toBe(legacyConfig)
  })

  test('recovers a missing staged credential from the migration backup', async () => {
    const legacyConfig = JSON.stringify({ githubToken: 'legacy-token', gheDomain: 'corp.ghe.com' })
    await fs.writeFile(credentialPaths.CONFIG_PATH, legacyConfig)
    await prepareGitHubCredential(credentialPaths)
    await fs.rm(credentialPaths.CREDENTIALS_PATH)
    await fs.writeFile(credentialPaths.CONFIG_PATH, JSON.stringify({ gheDomain: 'corp.ghe.com' }))

    const recovered = await prepareGitHubCredential(credentialPaths)

    expect(recovered).toEqual({
      accountName: 'default',
      githubToken: 'legacy-token',
      migrationPending: true,
      gheDomain: 'corp.ghe.com',
    })
    expect(await fs.readFile(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')).toBe(legacyConfig)
  })

  test('keeps the full backup when config cleanup cannot be completed', async () => {
    const legacyConfig = JSON.stringify({ githubToken: 'legacy-token', smallModel: 'gpt-5-mini' })
    await fs.writeFile(credentialPaths.CONFIG_PATH, legacyConfig)
    await prepareGitHubCredential(credentialPaths)
    await fs.writeFile(credentialPaths.CONFIG_PATH, '{ invalid json')

    await expect(
      finalizeGitHubCredentialMigration('legacy-token', credentialPaths),
    ).rejects.toThrow('migration backup')
    expect(await fs.readFile(credentialPaths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')).toBe(legacyConfig)
  })

  test('rejects an unsupported credential store version without overwriting the store', async () => {
    const original = JSON.stringify({
      version: 2,
      activeAccount: 'default',
      accounts: { default: { githubToken: 'dG9rZW4=' } },
    })
    await fs.writeFile(credentialPaths.CREDENTIALS_PATH, original)

    await expect(readGitHubCredential(credentialPaths)).rejects.toThrow('credentials.json')
    expect(await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')).toBe(original)
  })

  test('rejects invalid credential-store Base64 without overwriting the store', async () => {
    const original = JSON.stringify({
      version: 1,
      activeAccount: 'default',
      accounts: { default: { githubToken: '***' } },
    })
    await fs.writeFile(credentialPaths.CREDENTIALS_PATH, original)

    await expect(readGitHubCredential(credentialPaths)).rejects.toThrow('credentials.json')
    expect(await fs.readFile(credentialPaths.CREDENTIALS_PATH, 'utf8')).toBe(original)
  })

  test('ignores malformed non-credential config but protects a possible legacy token', async () => {
    await writeGitHubCredential('stored-token', undefined, credentialPaths)
    await fs.writeFile(credentialPaths.CONFIG_PATH, '{ invalid config')

    expect(await prepareGitHubCredential(credentialPaths)).toMatchObject({
      githubToken: 'stored-token',
      migrationPending: false,
    })

    const possibleLegacy = '{ "githubToken": "unterminated'
    await fs.writeFile(credentialPaths.CONFIG_PATH, possibleLegacy)
    await expect(prepareGitHubCredential(credentialPaths)).rejects.toThrow('left unchanged for recovery')
    expect(await fs.readFile(credentialPaths.CONFIG_PATH, 'utf8')).toBe(possibleLegacy)
  })
})
