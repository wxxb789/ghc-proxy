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

function normalizeSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(normalizeSchemaNode)
  }

  if (!isRecord(node)) {
    return node
  }

  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    // Copilot's function schema validator is stricter than OpenAI's public
    // surface and rejects several descriptive JSON Schema / OpenAPI
    // annotations. Strip those upstream-incompatible metadata fields while
    // preserving the structural schema shape used by clients and models.
    if (COPILOT_UNSUPPORTED_SCHEMA_ANNOTATIONS.has(key)) {
      continue
    }

    if (key === 'properties' && isRecord(value)) {
      normalized[key] = Object.fromEntries(
        Object.entries(value).map(([propertyName, propertySchema]) => [
          propertyName,
          normalizeSchemaNode(propertySchema),
        ]),
      )
      continue
    }

    normalized[key] = normalizeSchemaNode(value)
  }

  return normalized
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
  if (!schema) {
    return schema
  }

  return normalizeSchemaNode(schema) as T
}
