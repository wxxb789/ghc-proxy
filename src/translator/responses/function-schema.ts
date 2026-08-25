function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const COPILOT_UNSUPPORTED_SCHEMA_ANNOTATIONS = new Set([
  '$schema',
  '$id',
  'id',
  'title',
  'format',
  'default',
  'example',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'contentEncoding',
  'contentMediaType',
])

interface SchemaNodeNormalization {
  value: unknown
  changed: boolean
}

function normalizeSchemaNode(node: unknown): SchemaNodeNormalization {
  if (Array.isArray(node)) {
    const entries = node.map(normalizeSchemaNode)
    const changed = entries.some(entry => entry.changed)
    return {
      value: changed ? entries.map(entry => entry.value) : node,
      changed,
    }
  }

  if (!isRecord(node)) {
    return { value: node, changed: false }
  }

  let normalized: Record<string, unknown> = node
  let changed = false
  for (const [key, value] of Object.entries(node)) {
    // Copilot's function schema validator is stricter than OpenAI's public
    // surface and rejects several descriptive JSON Schema / OpenAPI
    // annotations. Strip those upstream-incompatible metadata fields while
    // preserving the structural schema shape used by clients and models.
    if (COPILOT_UNSUPPORTED_SCHEMA_ANNOTATIONS.has(key)) {
      if (!changed)
        normalized = { ...node }
      delete normalized[key]
      changed = true
      continue
    }

    if (key === 'properties' && isRecord(value)) {
      const properties = Object.entries(value).map(([propertyName, propertySchema]) => {
        return [propertyName, normalizeSchemaNode(propertySchema)] as const
      })
      if (properties.some(([, result]) => result.changed)) {
        if (!changed)
          normalized = { ...node }
        normalized[key] = Object.fromEntries(
          properties.map(([name, result]) => [name, result.value]),
        )
        changed = true
      }
      continue
    }

    const result = normalizeSchemaNode(value)
    if (result.changed) {
      if (!changed)
        normalized = { ...node }
      normalized[key] = result.value
      changed = true
    }
  }

  return {
    value: normalized,
    changed,
  }
}

export interface FunctionParametersSchemaNormalization<T> {
  schema: T
  changed: boolean
}

export function normalizeFunctionParametersSchemaForCopilotWithChangeMetadata<
  T extends Record<string, unknown> | null | undefined,
>(schema: T): FunctionParametersSchemaNormalization<T> {
  if (!schema) {
    return { schema, changed: false }
  }

  const normalized = normalizeSchemaNode(schema)
  return {
    schema: normalized.value as T,
    changed: normalized.changed,
  }
}

/**
 * Strip JSON Schema / OpenAPI annotations Copilot's function-schema validator
 * rejects, leaving the structural schema — including the caller's own
 * `required` array and `additionalProperties` — untouched.
 *
 * The annotation stripping is currently inert: probed 2026-08-06
 * (`scripts/probes/tool-strict.ts`), upstream accepts every annotation in the
 * list on every `/responses` model with `strict` omitted. It stays anyway — the
 * list was written against the upstream of 2026-04, and a probe result is a
 * dated snapshot rather than a permanent fact.
 */
export function normalizeFunctionParametersSchemaForCopilot<T extends Record<string, unknown> | null | undefined>(
  schema: T,
): T {
  return normalizeFunctionParametersSchemaForCopilotWithChangeMetadata(schema).schema
}
