import consola from 'consola'
import { z } from 'zod'

import { HTTPError } from '~/lib/error'

// ── Reusable Schema Primitives ──

export const jsonObjectSchema = z.object({}).catchall(z.unknown())
export const finiteNumberSchema = z.number().finite()
export const nonNegativeIntegerSchema = z.number().int().nonnegative()

export function createObjectSchemaDefinitionSchema(message: string) {
  return jsonObjectSchema.superRefine((schema, ctx) => {
    const typeValue = schema.type
    if (typeValue !== undefined && typeValue !== 'object') {
      ctx.addIssue({
        code: 'custom',
        message,
      })
    }
  })
}

// ── Generic Parse Helper ──

interface ValidationIssueDetail {
  path: Array<PropertyKey>
  message: string
  code?: string
  expected?: unknown
}

interface ZodIssueLike {
  path?: Array<PropertyKey>
  message?: string
  code?: string
  expected?: unknown
  errors?: unknown
  issues?: unknown
}

const MAX_VALIDATION_DETAILS = 200

function isIssueArray(value: unknown): value is Array<ZodIssueLike> {
  return Array.isArray(value)
    && value.every(item => typeof item === 'object' && item !== null)
}

function isNestedUnionErrors(value: unknown): value is Array<Array<ZodIssueLike>> {
  return Array.isArray(value) && value.every(isIssueArray)
}

function joinPath(prefix: Array<PropertyKey>, path: Array<PropertyKey> | undefined): Array<PropertyKey> {
  return [...prefix, ...(path ?? [])]
}

function flattenIssue(
  issue: ZodIssueLike,
  pathPrefix: Array<PropertyKey> = [],
): Array<ValidationIssueDetail> {
  const path = joinPath(pathPrefix, issue.path)

  if (issue.code === 'invalid_union' && isNestedUnionErrors(issue.errors)) {
    const nested = issue.errors.flatMap(errors =>
      errors.flatMap(error => flattenIssue(error, path)),
    )
    if (nested.length > 0) {
      return nested
    }
  }

  // zod 4.x emits `invalid_key` (record/map key refinement failure) and
  // `invalid_element` (set element failure) with the sub-issues hanging
  // off `.issues`, not `.errors`. Recurse so the inner constraint
  // (e.g. logit_bias key `^\d+$` regex mismatch) reaches the wire
  // `details` array instead of being swallowed by the generic outer
  // "Invalid key in record" message.
  if ((issue.code === 'invalid_key' || issue.code === 'invalid_element') && isIssueArray(issue.issues)) {
    const nested = issue.issues.flatMap(inner => flattenIssue(inner, path))
    if (nested.length > 0) {
      return nested
    }
  }

  return [{
    path,
    message: issue.message ?? 'Invalid input',
    ...(issue.code ? { code: issue.code } : {}),
    ...(issue.expected !== undefined ? { expected: issue.expected } : {}),
  }]
}

function formatValidationIssues(issues: Array<z.core.$ZodIssue>): Array<ValidationIssueDetail> {
  const seen = new Set<string>()
  const details: Array<ValidationIssueDetail> = []

  for (const issue of issues) {
    for (const detail of flattenIssue(issue as ZodIssueLike)) {
      const key = JSON.stringify([detail.path, detail.message, detail.code, detail.expected])
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      details.push(detail)
      if (details.length >= MAX_VALIDATION_DETAILS) {
        details.push({
          path: [],
          message: `Validation issue details truncated at ${MAX_VALIDATION_DETAILS} entries.`,
          code: 'too_many_issues',
        })
        return details
      }
    }
  }

  return details
}

function formatIssuePath(path: Array<PropertyKey>): string {
  if (path.length === 0) {
    return '(root)'
  }

  return path.map((part, index) => {
    if (typeof part === 'number') {
      return `[${part}]`
    }

    const value = String(part)
    return index === 0 ? value : `.${value}`
  }).join('')
}

function formatValidationIssuesForLog(
  details: Array<ValidationIssueDetail>,
): Array<Omit<ValidationIssueDetail, 'path'> & { path: string }> {
  return details.map(detail => ({
    ...detail,
    path: formatIssuePath(detail.path),
  }))
}

function throwInvalidPayload(context: string, issues: Array<z.core.$ZodIssue>): never {
  const details = formatValidationIssues(issues)
  consola.warn('Invalid request payload', {
    context,
    issues: formatValidationIssuesForLog(details),
  })
  throw new HTTPError(400, {
    error: {
      message: 'Invalid request payload',
      type: 'invalid_request_error',
      param: context,
      details,
    },
  })
}

export function parsePayload<T>(
  schema: z.ZodType<T>,
  context: string,
  payload: unknown,
): T {
  const result = schema.safeParse(payload)
  if (!result.success) {
    throwInvalidPayload(context, result.error.issues)
  }
  return result.data
}
