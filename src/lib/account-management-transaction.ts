import fs from 'node:fs/promises'

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

const transactionJournalSchema = z.object({
  version: z.literal(1),
  config: fileSnapshotSchema,
  credentials: fileSnapshotSchema,
}).strict()

type FileSnapshot = z.infer<typeof fileSnapshotSchema>

export interface AccountManagementTransactionPaths {
  ACCOUNT_MANAGEMENT_JOURNAL_PATH: string
  CONFIG_PATH: string
  CREDENTIALS_PATH: string
}

export async function beginAccountManagementTransaction(
  paths: AccountManagementTransactionPaths = PATHS,
): Promise<void> {
  const journal = {
    version: 1 as const,
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
}

export async function commitAccountManagementTransaction(
  paths: AccountManagementTransactionPaths = PATHS,
): Promise<void> {
  await fs.rm(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH)
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
  const content = await readTextFileIfExists(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH)
  if (content === undefined) {
    return false
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

  await restoreFileSnapshot(paths.CONFIG_PATH, result.data.config)
  await restoreFileSnapshot(paths.CREDENTIALS_PATH, result.data.credentials)
  await fs.rm(paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH)
  return true
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

function invalidJournalError(
  paths: AccountManagementTransactionPaths,
  cause: unknown,
): Error {
  return new Error(
    `Could not safely read account management transaction journal at ${paths.ACCOUNT_MANAGEMENT_JOURNAL_PATH}. Managed files were left unchanged.`,
    { cause },
  )
}
