import fs from 'node:fs/promises'
import process from 'node:process'
import consola from 'consola'

import { PATHS } from './paths'

interface ModelFallbackFileConfig {
  claudeOpus?: string
  claudeSonnet?: string
  claudeHaiku?: string
}

type ReasoningEffort
  = | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'

export interface ConfigFile {
  githubToken?: string
  modelFallback?: ModelFallbackFileConfig
  smallModel?: string
  compactUseSmallModel?: boolean
  warmupUseSmallModel?: boolean
  useFunctionApplyPatch?: boolean
  responsesApiContextManagementModels?: Array<string>
  modelReasoningEfforts?: Record<string, ReasoningEffort>
}

let cachedConfig: ConfigFile = {}

const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high'
const DEFAULT_USE_FUNCTION_APPLY_PATCH = true
const DEFAULT_COMPACT_USE_SMALL_MODEL = false
const DEFAULT_WARMUP_USE_SMALL_MODEL = false

export async function readConfig(): Promise<ConfigFile> {
  try {
    const content = await fs.readFile(PATHS.CONFIG_PATH, 'utf8')

    if (!content.trim()) {
      cachedConfig = {}
      return {}
    }

    const parsed = JSON.parse(content) as unknown

    if (
      typeof parsed !== 'object'
      || parsed === null
      || Array.isArray(parsed)
    ) {
      consola.warn('config.json is not a valid object. Using defaults.')
      cachedConfig = {}
      return {}
    }

    cachedConfig = parsed as ConfigFile
    return cachedConfig
  }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cachedConfig = {}
      return {}
    }

    consola.warn(
      `Failed to parse config.json: ${(error as Error).message}. Using defaults.`,
    )
    cachedConfig = {}
    return {}
  }
}

export function getCachedConfig(): ConfigFile {
  return cachedConfig
}

export function getSmallModel(): string | undefined {
  return cachedConfig.smallModel?.trim() || undefined
}

export function shouldCompactUseSmallModel(): boolean {
  return cachedConfig.compactUseSmallModel ?? DEFAULT_COMPACT_USE_SMALL_MODEL
}

export function shouldWarmupUseSmallModel(): boolean {
  return cachedConfig.warmupUseSmallModel ?? DEFAULT_WARMUP_USE_SMALL_MODEL
}

export function shouldUseFunctionApplyPatch(): boolean {
  return cachedConfig.useFunctionApplyPatch ?? DEFAULT_USE_FUNCTION_APPLY_PATCH
}

export function isResponsesApiContextManagementModel(model: string): boolean {
  return cachedConfig.responsesApiContextManagementModels?.includes(model) ?? false
}

export function getReasoningEffortForModel(model: string): ReasoningEffort {
  return cachedConfig.modelReasoningEfforts?.[model] ?? DEFAULT_REASONING_EFFORT
}

export async function writeConfigField(
  field: string,
  value: unknown,
): Promise<void> {
  try {
    let existing: ConfigFile = {}
    try {
      const content = await fs.readFile(PATHS.CONFIG_PATH, 'utf8')
      if (content.trim()) {
        existing = JSON.parse(content) as ConfigFile
      }
    }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        consola.warn(
          `Could not read existing config.json: ${
            (error as Error).message
          }. Starting fresh.`,
        )
      }
    }

    const merged = { ...existing, [field]: value }

    await fs.writeFile(
      PATHS.CONFIG_PATH,
      JSON.stringify(merged, null, 2),
      'utf8',
    )
    await applyConfigFilePermissions(PATHS.CONFIG_PATH)

    cachedConfig = merged
  }
  catch (error: unknown) {
    consola.error(`Failed to write config.json: ${(error as Error).message}`)
    throw error
  }
}

async function applyConfigFilePermissions(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }

  try {
    await fs.chmod(filePath, 0o600)
  }
  catch (error) {
    consola.warn(
      `Could not set config.json permissions to 0600: ${(error as Error).message}`,
    )
  }
}
