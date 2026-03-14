import consola from 'consola'
import { z } from 'zod'

import { HTTPError } from '../error'

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

function throwInvalidPayload(context: string, issues: Array<z.core.$ZodIssue>): never {
  consola.warn('Invalid request payload', { context, issues })
  throw new HTTPError(400, {
    error: {
      message: 'Invalid request payload',
      type: 'invalid_request_error',
      param: context,
      details: issues.map(i => ({ path: i.path, message: i.message })),
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
