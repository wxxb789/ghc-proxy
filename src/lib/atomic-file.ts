import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import process from 'node:process'

const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 25, 50] as const

export async function writePrivateFileAtomically(
  filePath: string,
  content: string,
): Promise<void> {
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

export async function writePrivateFileAtomicallyIfAbsent(
  filePath: string,
  content: string,
): Promise<void> {
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

export async function applyPrivateFilePermissions(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  await fs.chmod(filePath, 0o600)
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
