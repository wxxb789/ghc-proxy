import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import process from 'node:process'
import consola from 'consola'
import { z } from 'zod'

import { PATHS } from '~/lib/paths'
import { formatErrorMessage } from '~/lib/retry'

const CREDENTIALS_VERSION = 1
const CREDENTIAL_MIGRATION_JOURNAL_VERSION = 1
const DEFAULT_CREDENTIAL_ACCOUNT = 'default'
const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 25, 50] as const

const BASE64_RE = /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i
const SHA256_RE = /^[a-f0-9]{64}$/

const credentialAccountSchema = z.object({
  githubToken: z.string().min(1),
  gheDomain: z.string().min(1).optional(),
}).passthrough()

const credentialStoreSchema = z.object({
  version: z.literal(CREDENTIALS_VERSION),
  activeAccount: z.string().min(1),
  accounts: z.record(z.string().min(1), credentialAccountSchema),
}).passthrough()

const credentialMigrationJournalSchema = z.object({
  version: z.literal(CREDENTIAL_MIGRATION_JOURNAL_VERSION),
  legacyTokenDigest: z.string().regex(SHA256_RE),
  replacementTokenDigest: z.string().regex(SHA256_RE),
}).strict()

type CredentialStoreFile = z.infer<typeof credentialStoreSchema>
type CredentialMigrationJournal = z.infer<typeof credentialMigrationJournalSchema>

export interface CredentialPaths {
  CONFIG_PATH: string
  CREDENTIALS_PATH: string
  CONFIG_MIGRATION_BACKUP_PATH: string
}

export interface GitHubCredential {
  accountName: string
  githubToken: string
  gheDomain?: string
}

export interface GitHubCredentialStore {
  activeAccount: string
  accounts: Record<string, GitHubCredential>
}

export interface PreparedGitHubCredential extends GitHubCredential {
  migrationPending: boolean
  replacementPending?: true
}

export interface GitHubCredentialStatus {
  error?: string
  migrationPending: boolean
  tokenExists: boolean
}

interface LegacyConfig {
  content: string
  githubToken?: string
  gheDomain?: string
  raw: Record<string, unknown>
}

export class CredentialMigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CredentialMigrationError'
  }
}

export async function readGitHubCredential(
  paths: CredentialPaths = PATHS,
  accountName?: string,
): Promise<GitHubCredential | undefined> {
  const store = await readGitHubCredentials(paths)
  if (!store) {
    return undefined
  }

  const selectedAccount = accountName ?? store.activeAccount
  const account = store.accounts[selectedAccount]
  if (!account) {
    throw new Error(
      accountName
        ? `credentials.json at ${paths.CREDENTIALS_PATH} does not contain account "${accountName}". The file was left unchanged.`
        : `credentials.json at ${paths.CREDENTIALS_PATH} selects missing account "${store.activeAccount}". The file was left unchanged.`,
    )
  }
  return account
}

export async function readGitHubCredentials(
  paths: CredentialPaths = PATHS,
): Promise<GitHubCredentialStore | undefined> {
  const store = await readCredentialStore(paths)
  if (!store) {
    return undefined
  }
  if (!store.accounts[store.activeAccount]) {
    throw new Error(
      `credentials.json at ${paths.CREDENTIALS_PATH} selects missing account "${store.activeAccount}". The file was left unchanged.`,
    )
  }

  const accounts = Object.fromEntries(
    Object.entries(store.accounts).map(([accountName, account]) => [
      accountName,
      {
        accountName,
        githubToken: decodeToken(account.githubToken, accountName, paths),
        gheDomain: account.gheDomain,
      },
    ]),
  )

  return { activeAccount: store.activeAccount, accounts }
}

export async function writeGitHubCredential(
  githubToken: string,
  gheDomain?: string,
  paths: CredentialPaths = PATHS,
  accountName?: string,
): Promise<void> {
  const token = githubToken.trim()
  if (!token) {
    throw new Error('Refusing to persist an empty GitHub token.')
  }

  const existing = await readCredentialStore(paths)
  const selectedAccount = accountName ?? existing?.activeAccount ?? DEFAULT_CREDENTIAL_ACCOUNT
  const activeAccount = existing?.activeAccount ?? selectedAccount
  const existingAccount = existing?.accounts[selectedAccount]
  const account: z.infer<typeof credentialAccountSchema> = {
    ...existingAccount,
    githubToken: Buffer.from(token, 'utf8').toString('base64'),
  }
  if (gheDomain) {
    account.gheDomain = gheDomain
  }
  else {
    delete account.gheDomain
  }

  const next: CredentialStoreFile = {
    ...existing,
    version: CREDENTIALS_VERSION,
    activeAccount,
    accounts: {
      ...existing?.accounts,
      [selectedAccount]: account,
    },
  }

  await writePrivateFileAtomically(
    paths.CREDENTIALS_PATH,
    `${JSON.stringify(next, null, 2)}\n`,
  )
}

export async function replaceGitHubCredentialDuringMigration(
  expectedLegacyToken: string,
  replacementToken: string,
  replacementGheDomain?: string,
  paths: CredentialPaths = PATHS,
): Promise<void> {
  const expectedToken = expectedLegacyToken.trim()
  const nextToken = replacementToken.trim()
  if (!expectedToken) {
    throw new Error('Refusing to replace a migration credential without the expected legacy GitHub token.')
  }
  if (!nextToken) {
    throw new Error('Refusing to replace a migration credential with an empty GitHub token.')
  }

  try {
    const backup = await readLegacyConfigFileIfExists(
      paths.CONFIG_MIGRATION_BACKUP_PATH,
    )
    if (!backup?.githubToken || backup.githubToken !== expectedToken) {
      throw new Error('The migration backup does not match the expected legacy GitHub token.')
    }

    const current = await readLegacyConfigFile(paths.CONFIG_PATH)
    if (current.githubToken && current.githubToken !== expectedToken) {
      throw new Error('config.json contains a different legacy GitHub token than expected.')
    }

    const credential = await requireGitHubCredential(paths)
    if (credential.githubToken !== expectedToken) {
      throw new Error('The active stored GitHub credential does not match the expected legacy GitHub token.')
    }

    await writeCredentialMigrationJournal({
      version: CREDENTIAL_MIGRATION_JOURNAL_VERSION,
      legacyTokenDigest: tokenDigest(expectedToken),
      replacementTokenDigest: tokenDigest(nextToken),
    }, paths)
    await writeGitHubCredential(nextToken, replacementGheDomain, paths)
    if (!await finalizeGitHubCredentialMigration(nextToken, paths)) {
      throw new Error('The migration backup disappeared before the replacement commit could be finalized.')
    }
  }
  catch (error) {
    if (error instanceof CredentialMigrationError) {
      throw error
    }
    throw new CredentialMigrationError(
      `GitHub credential migration replacement was not fully committed. config.json is at ${paths.CONFIG_PATH}, the migration backup is at ${paths.CONFIG_MIGRATION_BACKUP_PATH}, and the transaction journal is at ${migrationJournalPath(paths)}. These files preserve a restart recovery path. Cause: ${formatErrorMessage(error)}`,
      { cause: error },
    )
  }
}

export async function prepareGitHubCredential(
  paths: CredentialPaths = PATHS,
  accountName?: string,
): Promise<PreparedGitHubCredential | undefined> {
  if (accountName !== undefined && accountName !== DEFAULT_CREDENTIAL_ACCOUNT) {
    const store = await readGitHubCredentials(paths)
    const credential = store?.accounts[accountName]
    return credential ? { ...credential, migrationPending: false } : undefined
  }

  const migration = await preparePendingGitHubCredentialMigration(paths)
  if (migration) {
    return migration
  }

  await removeStaleMigrationJournal(paths)
  const credential = await readGitHubCredential(paths, accountName)
  return credential ? { ...credential, migrationPending: false } : undefined
}

export async function preparePendingGitHubCredentialMigration(
  paths: CredentialPaths = PATHS,
): Promise<PreparedGitHubCredential | undefined> {
  const legacy = await readLegacyConfig(paths)

  if (legacy?.githubToken) {
    try {
      const backup = await ensureMigrationBackup(legacy, paths)
      return preparePendingCredentialMigration(backup, paths)
    }
    catch (error) {
      throw migrationError('staging', paths, error)
    }
  }

  const backup = await readLegacyConfigFileIfExists(
    paths.CONFIG_MIGRATION_BACKUP_PATH,
  )
  if (backup) {
    try {
      return preparePendingCredentialMigration(backup, paths)
    }
    catch (error) {
      throw migrationError('recovery', paths, error)
    }
  }

  return undefined
}

export async function finalizeGitHubCredentialMigration(
  githubToken: string,
  paths: CredentialPaths = PATHS,
): Promise<boolean> {
  const backup = await readLegacyConfigFileIfExists(
    paths.CONFIG_MIGRATION_BACKUP_PATH,
  )
  if (!backup) {
    await removeStaleMigrationJournal(paths)
    return false
  }

  try {
    if (!backup.githubToken) {
      throw new Error('The migration backup does not contain a usable GitHub token.')
    }

    const journal = await readCredentialMigrationJournalIfExists(paths)
    if (journal && journal.legacyTokenDigest !== tokenDigest(backup.githubToken)) {
      throw new Error('The transaction journal does not match the migration backup.')
    }

    const credential = await requireGitHubCredential(paths)
    const validatedToken = githubToken.trim()
    if (journal) {
      if (
        tokenDigest(credential.githubToken) !== journal.replacementTokenDigest
        || tokenDigest(validatedToken) !== journal.replacementTokenDigest
      ) {
        throw new Error(
          'The active stored GitHub credential and validated runtime credential must match the transaction journal replacement before finalizing the migration.',
        )
      }
    }
    else if (
      credential.githubToken !== backup.githubToken
      || credential.githubToken !== validatedToken
    ) {
      throw new Error(
        'The active stored GitHub credential, migration backup, and validated runtime credential must match before finalizing the migration.',
      )
    }

    const current = await readLegacyConfigFile(paths.CONFIG_PATH)
    if (
      current.githubToken
      && current.githubToken !== backup.githubToken
    ) {
      throw new Error('config.json contains a different legacy GitHub token than the migration backup.')
    }

    if ('githubToken' in current.raw || journal) {
      const cleaned = { ...current.raw }
      delete cleaned.githubToken
      if (journal) {
        if (credential.gheDomain) {
          cleaned.gheDomain = credential.gheDomain
        }
        else {
          delete cleaned.gheDomain
        }
      }
      await writePrivateFileAtomically(
        paths.CONFIG_PATH,
        `${JSON.stringify(cleaned, null, 2)}\n`,
      )
    }

    await removeCredentialMigrationBackup(paths)
    if (journal) {
      try {
        await removeCredentialMigrationJournal(paths)
      }
      catch (error) {
        throw new CredentialMigrationError(
          `GitHub credential migration completed, but the stale transaction journal at ${migrationJournalPath(paths)} could not be removed. The active credential remains usable; remove the journal before a future migration. Cause: ${formatErrorMessage(error)}`,
          { cause: error },
        )
      }
    }
    consola.debug('GitHub credential migration completed; the temporary config backup was removed.')
    return true
  }
  catch (error) {
    if (error instanceof CredentialMigrationError) {
      throw error
    }
    throw migrationError('finalization', paths, error)
  }
}

export async function inspectGitHubCredential(
  paths: CredentialPaths = PATHS,
): Promise<GitHubCredentialStatus> {
  const migrationPending = await pathExists(paths.CONFIG_MIGRATION_BACKUP_PATH)
  try {
    const credential = await readGitHubCredential(paths)
    const legacy = await readLegacyConfig(paths)
    return {
      migrationPending,
      tokenExists: Boolean(credential ?? legacy?.githubToken),
    }
  }
  catch (error) {
    return {
      error: formatErrorMessage(error),
      migrationPending,
      tokenExists: false,
    }
  }
}

async function preparePendingCredentialMigration(
  backup: LegacyConfig,
  paths: CredentialPaths,
): Promise<PreparedGitHubCredential> {
  const backupToken = backup.githubToken
  if (!backupToken) {
    throw new Error('The migration backup does not contain a usable GitHub token.')
  }

  const journal = await readCredentialMigrationJournalIfExists(paths)
  if (journal && journal.legacyTokenDigest !== tokenDigest(backupToken)) {
    throw new Error('The transaction journal does not match the migration backup.')
  }

  let credential = await readGitHubCredential(paths)
  if (!credential) {
    await stageGitHubCredential(backupToken, backup.gheDomain, paths)
    credential = await requireGitHubCredential(paths)
    if (!journal) {
      consola.warn(
        `Recovered the pending GitHub credential from ${paths.CONFIG_MIGRATION_BACKUP_PATH}.`,
      )
    }
  }

  if (!journal) {
    if (credential.githubToken !== backupToken) {
      throw new Error(
        'The active stored GitHub credential does not match the migration backup. Resolve the credential mismatch before continuing the migration.',
      )
    }
    return { ...credential, migrationPending: true }
  }

  const activeTokenDigest = tokenDigest(credential.githubToken)
  if (activeTokenDigest === journal.replacementTokenDigest) {
    return { ...credential, migrationPending: true, replacementPending: true }
  }
  if (activeTokenDigest === journal.legacyTokenDigest) {
    await removeCredentialMigrationJournal(paths)
    return { ...credential, migrationPending: true }
  }
  throw new Error('The active stored GitHub credential does not match the migration backup or transaction journal replacement.')
}

async function readCredentialStore(
  paths: CredentialPaths,
): Promise<CredentialStoreFile | undefined> {
  let content: string
  try {
    content = await fs.readFile(paths.CREDENTIALS_PATH, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw new Error(
      `Could not read credentials.json at ${paths.CREDENTIALS_PATH}: ${formatErrorMessage(error)}.`,
      { cause: error },
    )
  }

  let raw: unknown
  try {
    raw = JSON.parse(content) as unknown
  }
  catch (error) {
    throw new Error(
      `credentials.json at ${paths.CREDENTIALS_PATH} is not valid JSON. The file was left unchanged.`,
      { cause: error },
    )
  }

  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const version = (raw as Record<string, unknown>).version
    if (version !== CREDENTIALS_VERSION) {
      throw new Error(
        `credentials.json at ${paths.CREDENTIALS_PATH} has unsupported version ${String(version)}. The file was left unchanged.`,
      )
    }
  }

  const result = credentialStoreSchema.safeParse(raw)
  if (!result.success) {
    throw new Error(
      `credentials.json at ${paths.CREDENTIALS_PATH} has an invalid schema. The file was left unchanged.`,
    )
  }
  return result.data
}

function decodeToken(
  encoded: string,
  accountName: string,
  paths: CredentialPaths,
): string {
  if (!BASE64_RE.test(encoded)) {
    throw invalidBase64Error(accountName, paths)
  }

  const bytes = Buffer.from(encoded, 'base64')
  const token = bytes.toString('utf8')
  if (
    !token
    || token !== token.trim()
    || Buffer.from(token, 'utf8').toString('base64') !== encoded
  ) {
    throw invalidBase64Error(accountName, paths)
  }
  return token
}

function invalidBase64Error(accountName: string, paths: CredentialPaths): Error {
  return new Error(
    `credentials.json at ${paths.CREDENTIALS_PATH} contains invalid Base64 for account "${accountName}". The file was left unchanged.`,
  )
}

async function readLegacyConfig(
  paths: CredentialPaths,
): Promise<LegacyConfig | undefined> {
  try {
    return await readLegacyConfigFileIfExists(paths.CONFIG_PATH)
  }
  catch (error) {
    let content: string
    try {
      content = await fs.readFile(paths.CONFIG_PATH, 'utf8')
    }
    catch {
      throw error
    }
    if (content.includes('"githubToken"')) {
      throw new CredentialMigrationError(
        `Could not safely inspect the legacy GitHub credential in ${paths.CONFIG_PATH}. The file was left unchanged for recovery.`,
        { cause: error },
      )
    }
    return undefined
  }
}

async function readLegacyConfigFileIfExists(
  filePath: string,
): Promise<LegacyConfig | undefined> {
  try {
    return await readLegacyConfigFile(filePath)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

async function readLegacyConfigFile(filePath: string): Promise<LegacyConfig> {
  const content = await fs.readFile(filePath, 'utf8')
  let raw: unknown
  try {
    raw = JSON.parse(content) as unknown
  }
  catch (error) {
    throw new Error(`${filePath} is not valid JSON and was left unchanged.`, { cause: error })
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${filePath} is not a JSON object and was left unchanged.`)
  }

  const rawObject = raw as Record<string, unknown>
  const token = typeof rawObject.githubToken === 'string'
    ? rawObject.githubToken.trim()
    : undefined
  return {
    content,
    githubToken: token || undefined,
    gheDomain: typeof rawObject.gheDomain === 'string' && rawObject.gheDomain
      ? rawObject.gheDomain
      : undefined,
    raw: rawObject,
  }
}

async function ensureMigrationBackup(
  legacy: LegacyConfig,
  paths: CredentialPaths,
): Promise<LegacyConfig> {
  try {
    await fs.copyFile(
      paths.CONFIG_PATH,
      paths.CONFIG_MIGRATION_BACKUP_PATH,
      fsConstants.COPYFILE_EXCL,
    )
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
    const backup = await readLegacyConfigFile(paths.CONFIG_MIGRATION_BACKUP_PATH)
    if (!backup.githubToken) {
      throw new Error('The existing migration backup does not contain a usable GitHub token.')
    }
    if (backup.githubToken !== legacy.githubToken) {
      throw new Error('The existing migration backup belongs to a different legacy GitHub token.')
    }
    return backup
  }

  await applyPrivateFilePermissions(paths.CONFIG_MIGRATION_BACKUP_PATH)

  const copied = await fs.readFile(paths.CONFIG_MIGRATION_BACKUP_PATH, 'utf8')
  if (copied !== legacy.content) {
    throw new Error('The migration backup did not preserve the complete config.json contents.')
  }
  return readLegacyConfigFile(paths.CONFIG_MIGRATION_BACKUP_PATH)
}

async function stageGitHubCredential(
  githubToken: string,
  gheDomain: string | undefined,
  paths: CredentialPaths,
): Promise<void> {
  const account: z.infer<typeof credentialAccountSchema> = {
    githubToken: Buffer.from(githubToken, 'utf8').toString('base64'),
  }
  if (gheDomain) {
    account.gheDomain = gheDomain
  }

  const staged: CredentialStoreFile = {
    version: CREDENTIALS_VERSION,
    activeAccount: DEFAULT_CREDENTIAL_ACCOUNT,
    accounts: {
      [DEFAULT_CREDENTIAL_ACCOUNT]: account,
    },
  }
  await writePrivateFileAtomicallyIfAbsent(
    paths.CREDENTIALS_PATH,
    `${JSON.stringify(staged, null, 2)}\n`,
  )
}

function migrationJournalPath(paths: CredentialPaths): string {
  return `${paths.CONFIG_MIGRATION_BACKUP_PATH}.replacement.json`
}

async function readCredentialMigrationJournalIfExists(
  paths: CredentialPaths,
): Promise<CredentialMigrationJournal | undefined> {
  const filePath = migrationJournalPath(paths)
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw new Error(
      `Could not read credential migration transaction journal at ${filePath}: ${formatErrorMessage(error)}.`,
      { cause: error },
    )
  }

  let raw: unknown
  try {
    raw = JSON.parse(content) as unknown
  }
  catch (error) {
    throw new Error(
      `Credential migration transaction journal at ${filePath} is not valid JSON and was left unchanged.`,
      { cause: error },
    )
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const version = (raw as Record<string, unknown>).version
    if (version !== CREDENTIAL_MIGRATION_JOURNAL_VERSION) {
      throw new Error(
        `Credential migration transaction journal at ${filePath} has unsupported version ${String(version)} and was left unchanged.`,
      )
    }
  }

  const result = credentialMigrationJournalSchema.safeParse(raw)
  if (!result.success) {
    throw new Error(
      `Credential migration transaction journal at ${filePath} has an invalid schema and was left unchanged.`,
    )
  }
  return result.data
}

async function writeCredentialMigrationJournal(
  journal: CredentialMigrationJournal,
  paths: CredentialPaths,
): Promise<void> {
  await writePrivateFileAtomically(
    migrationJournalPath(paths),
    `${JSON.stringify(journal, null, 2)}\n`,
  )
}

async function removeCredentialMigrationJournal(paths: CredentialPaths): Promise<void> {
  try {
    await fs.unlink(migrationJournalPath(paths))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

async function removeCredentialMigrationBackup(paths: CredentialPaths): Promise<void> {
  try {
    await fs.unlink(paths.CONFIG_MIGRATION_BACKUP_PATH)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

async function removeStaleMigrationJournal(paths: CredentialPaths): Promise<void> {
  if (await pathExists(paths.CONFIG_MIGRATION_BACKUP_PATH)) {
    return
  }
  await removeCredentialMigrationJournal(paths)
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

async function requireGitHubCredential(paths: CredentialPaths): Promise<GitHubCredential> {
  const credential = await readGitHubCredential(paths)
  if (!credential) {
    throw new Error(`No active GitHub credential exists in ${paths.CREDENTIALS_PATH}.`)
  }
  return credential
}

async function writePrivateFileAtomically(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
    await applyPrivateFilePermissions(temporaryPath)
    await replacePrivateFile(temporaryPath, filePath)
    await applyPrivateFilePermissions(filePath)
  }
  finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function replacePrivateFile(temporaryPath: string, filePath: string): Promise<void> {
  for (const delayMs of WINDOWS_RENAME_RETRY_DELAYS_MS) {
    try {
      await fs.rename(temporaryPath, filePath)
      return
    }
    catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  await fs.rename(temporaryPath, filePath)
}

async function writePrivateFileAtomicallyIfAbsent(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
    await applyPrivateFilePermissions(temporaryPath)
    try {
      await fs.link(temporaryPath, filePath)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
  }
  finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function applyPrivateFilePermissions(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  await fs.chmod(filePath, 0o600)
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  }
  catch {
    return false
  }
}

function migrationError(
  stage: string,
  paths: CredentialPaths,
  cause: unknown,
): CredentialMigrationError {
  return new CredentialMigrationError(
    `GitHub credential migration failed during ${stage}. config.json remains at ${paths.CONFIG_PATH}; any migration backup created is kept at ${paths.CONFIG_MIGRATION_BACKUP_PATH}. Restore from that backup if needed. Cause: ${formatErrorMessage(cause)}`,
    { cause },
  )
}
