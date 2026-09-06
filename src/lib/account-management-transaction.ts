import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { z } from 'zod'

import {
  writePrivateFileAtomically,
  writePrivateFileAtomicallyIfAbsent,
} from '~/lib/atomic-file'
import { PATHS } from '~/lib/paths'

const fileSnapshotSchema = z.discriminatedUnion('exists', [
  z.object({ exists: z.literal(false) }).strict(),
  z.object({ exists: z.literal(true), content: z.string() }).strict(),
])

const transactionJournalSchema = z.discriminatedUnion('version', [
  z.object({
    version: z.literal(1),
    config: fileSnapshotSchema,
    credentials: fileSnapshotSchema,
  }).strict(),
  z.object({
    version: z.literal(2),
    owner: z.object({
      pid: z.number().int().positive().safe(),
      token: z.string().min(1),
    }).strict(),
    config: fileSnapshotSchema,
    credentials: fileSnapshotSchema,
  }).strict(),
])

type FileSnapshot = z.infer<typeof fileSnapshotSchema>
type TransactionJournal = z.infer<typeof transactionJournalSchema>

const ownedTransactions = new Map<string, string>()

export interface AccountManagementTransactionPaths {
  ACCOUNT_MANAGEMENT_JOURNAL_PATH: string
  CONFIG_PATH: string
  CREDENTIALS_PATH: string
}

export async function beginAccountManagementTransaction(
  paths: AccountManagementTransactionPaths = PATHS,
): Promise<void> {
  const ownerToken = randomUUID()
  const journal = {
    version: 2 as const,
    owner: {
      pid: process.pid,
      token: ownerToken,
    },
    config: await readFileSnapshot(paths.CONFIG_PATH),
    credentials: await readFileSnapshot(paths.CREDENTIALS_PATH),
  }
  const created = await writePrivateFileAtomicallyIfAbsent(
    paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH,
    `${JSON.stringify(journal, null, 2)}\n`,
  )
  if (!created) {
    throw new Error(
      `Cannot start account management update while an unfinished account management transaction exists at ${paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH}.`,
    )
  }
  ownedTransactions.set(transactionKey(paths), ownerToken)
}

export async function commitAccountManagementTransaction(
  paths: AccountManagementTransactionPaths = PATHS,
): Promise<void> {
  const journal = await readTransactionJournal(paths)
  if (journal === undefined) {
    throw new Error('No unfinished account management transaction exists to commit.')
  }
  assertOwnedTransaction(paths, journal)
  await fs.rm(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH)
  clearOwnedTransaction(paths, journal)
}

export async function rollbackAccountManagementTransaction(
  paths: AccountManagementTransactionPaths = PATHS,
): Promise<void> {
  const recovered = await recoverAccountManagementTransaction(paths)
  if (!recovered) {
    throw new Error('No unfinished account management transaction exists to roll back.')
  }
}

export async function recoverAccountManagementTransaction(
  paths: AccountManagementTransactionPaths = PATHS,
): Promise<boolean> {
  return recoverAccountManagementTransactionWithOwner(
    paths,
    ownedTransactions.get(transactionKey(paths)),
  )
}

async function recoverAccountManagementTransactionWithOwner(
  paths: AccountManagementTransactionPaths,
  ownerToken?: string,
): Promise<boolean> {
  const journal = await readTransactionJournal(paths)
  if (journal === undefined) {
    return false
  }

  if (
    journal.version === 2
    && !isOwnedTransaction(paths, journal, ownerToken)
  ) {
    assertOwnerExited(paths, journal.owner.pid)
  }

  await restoreFileSnapshot(paths.CONFIG_PATH, journal.config)
  await restoreFileSnapshot(paths.CREDENTIALS_PATH, journal.credentials)
  await fs.rm(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH)
  clearOwnedTransaction(paths, journal)
  return true
}

async function readTransactionJournal(
  paths: AccountManagementTransactionPaths,
): Promise<TransactionJournal | undefined> {
  const content = await readTextFileIfExists(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH)
  if (content === undefined) {
    return undefined
  }

  let raw: unknown
  try {
    raw = JSON.parse(content)
  }
  catch (error) {
    throw invalidJournalError(paths, error)
  }

  const result = transactionJournalSchema.safeParse(raw)
  if (!result.success) {
    throw invalidJournalError(paths, result.error)
  }
  return result.data
}

async function readFileSnapshot(filePath: string): Promise<FileSnapshot> {
  const content = await readTextFileIfExists(filePath)
  return content === undefined
    ? { exists: false }
    : { exists: true, content }
}

async function readTextFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

async function restoreFileSnapshot(
  filePath: string,
  snapshot: FileSnapshot,
): Promise<void> {
  if (snapshot.exists) {
    await writePrivateFileAtomically(filePath, snapshot.content)
    return
  }
  await fs.rm(filePath, { force: true })
}

function assertOwnedTransaction(
  paths: AccountManagementTransactionPaths,
  journal: TransactionJournal,
): asserts journal is Extract<TransactionJournal, { version: 2 }> {
  const ownerToken = ownedTransactions.get(transactionKey(paths))
  if (
    journal.version !== 2
    || !isOwnedTransaction(paths, journal, ownerToken)
  ) {
    throw new Error(
      `Cannot commit account management transaction at ${paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH} because it is not owned by this process.`,
    )
  }
}

function isOwnedTransaction(
  paths: AccountManagementTransactionPaths,
  journal: Extract<TransactionJournal, { version: 2 }>,
  ownerToken: string | undefined,
): boolean {
  return journal.owner.pid === process.pid
    && ownerToken !== undefined
    && ownerToken === journal.owner.token
    && ownedTransactions.get(transactionKey(paths)) === ownerToken
}

function assertOwnerExited(
  paths: AccountManagementTransactionPaths,
  ownerPid: number,
): void {
  try {
    process.kill(ownerPid, 0)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return
    }
    throw new Error(
      `Could not safely determine whether account management transaction owner process ${ownerPid} is still running. Managed files and journal at ${paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH} were left unchanged.`,
      { cause: error },
    )
  }
  throw new Error(
    `Cannot recover account management transaction at ${paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH} because it is owned by live process ${ownerPid}. Managed files and journal were left unchanged.`,
  )
}

function clearOwnedTransaction(
  paths: AccountManagementTransactionPaths,
  journal: TransactionJournal,
): void {
  if (
    journal.version === 2
    && ownedTransactions.get(transactionKey(paths)) === journal.owner.token
  ) {
    ownedTransactions.delete(transactionKey(paths))
  }
}

function transactionKey(paths: AccountManagementTransactionPaths): string {
  return path.resolve(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH)
}

function invalidJournalError(
  paths: AccountManagementTransactionPaths,
  cause: unknown,
): Error {
  return new Error(
    `Could not safely read account management transaction journal at ${paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH}. Managed files were left unchanged.`,
    { cause },
  )
}
