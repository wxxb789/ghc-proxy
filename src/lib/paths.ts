import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const APP_DIR = path.join(os.homedir(), '.local', 'share', 'ghc-proxy')

const CONFIG_PATH = path.join(APP_DIR, 'config.json')
const CREDENTIALS_PATH = path.join(APP_DIR, 'credentials.json')
const CONFIG_MIGRATION_BACKUP_PATH = path.join(
  APP_DIR,
  'config.json.github-token-migration.bak',
)

export const PATHS = {
  APP_DIR,
  CONFIG_PATH,
  CONFIG_MIGRATION_BACKUP_PATH,
  CREDENTIALS_PATH,
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
}
