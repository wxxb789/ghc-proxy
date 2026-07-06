import fs from 'node:fs/promises'
import process from 'node:process'
import consola from 'consola'
import { z } from 'zod'

import { PATHS } from './paths'

const reasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
])

export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>

const configFileSchema = z.object({
  githubToken: z.string().optional(),
  modelFallback: z.object({
    claudeOpus: z.string().optional(),
    claudeSonnet: z.string().optional(),
    claudeHaiku: z.string().optional(),
  }).optional(),
  smallModel: z.string().optional(),
  compactUseSmallModel: z.boolean().optional(),
  useFunctionApplyPatch: z.boolean().optional(),
  responsesApiAutoCompactInput: z.boolean().optional(),
  responsesApiAutoContextManagement: z.boolean().optional(),
  responsesApiContextManagementModels: z.array(z.string()).optional(),
  responsesApiParameterFilters: z.array(z.object({
    models: z.array(z.string()).min(1),
    params: z.array(z.string()).min(1),
  })).optional(),
  responsesApiParameterFiltersReplaceDefault: z.boolean().optional(),
  responsesOfficialEmulator: z.boolean().optional(),
  responsesOfficialEmulatorTtlSeconds: z.number().int().positive().optional(),
  modelReasoningEfforts: z.record(z.string(), reasoningEffortSchema).optional(),
  modelRewrites: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  upstreamQueueConcurrency: z.number().int().positive().optional(),
  upstreamQueueMaxRetries: z.number().int().nonnegative().optional(),
  upstreamQueueBaseDelaySeconds: z.number().int().nonnegative().optional(),
  upstreamQueueMaxDelaySeconds: z.number().int().positive().optional(),
  gheDomain: z.string().optional(),
}).passthrough()

export type ConfigFile = z.infer<typeof configFileSchema>

const KNOWN_CONFIG_KEYS = new Set(Object.keys(configFileSchema.shape))

let cachedConfig: ConfigFile = {}

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high'
export const DEFAULT_USE_FUNCTION_APPLY_PATCH = true
export const DEFAULT_COMPACT_USE_SMALL_MODEL = false
export const DEFAULT_RESPONSES_API_AUTO_COMPACT_INPUT = false
export const DEFAULT_RESPONSES_API_AUTO_CONTEXT_MANAGEMENT = false
export const DEFAULT_RESPONSES_API_PARAMETER_FILTERS_REPLACE_DEFAULT = false
export const DEFAULT_RESPONSES_OFFICIAL_EMULATOR = false
export const DEFAULT_RESPONSES_OFFICIAL_EMULATOR_TTL_SECONDS = 14_400

export async function readConfig(): Promise<ConfigFile> {
  try {
    const content = await fs.readFile(PATHS.CONFIG_PATH, 'utf8')

    if (!content.trim()) {
      cachedConfig = {}
      return {}
    }

    const raw = JSON.parse(content) as unknown

    if (
      typeof raw !== 'object'
      || raw === null
      || Array.isArray(raw)
    ) {
      consola.warn('config.json is not a valid object. Using defaults.')
      cachedConfig = {}
      return {}
    }

    const result = configFileSchema.safeParse(raw)
    if (!result.success) {
      consola.warn(
        'config.json has invalid fields:',
        result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
        'Using defaults for invalid fields.',
      )
      // Pick only individually valid fields to avoid unsafe casts
      const partial: Record<string, unknown> = {}
      const rawObj = raw as Record<string, unknown>
      for (const [key, schema] of Object.entries(configFileSchema.shape)) {
        if (key in rawObj) {
          const fieldResult = (schema as z.ZodTypeAny).safeParse(rawObj[key])
          if (fieldResult.success) {
            partial[key] = fieldResult.data
          }
        }
      }
      cachedConfig = partial as ConfigFile
      return cachedConfig
    }

    // Warn about unknown fields
    const unknownKeys = Object.keys(raw as Record<string, unknown>)
      .filter(key => !KNOWN_CONFIG_KEYS.has(key))
    if (unknownKeys.length > 0) {
      consola.warn(`config.json contains unknown fields: ${unknownKeys.join(', ')}`)
    }

    cachedConfig = result.data
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
