import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

import consola from 'consola'

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export async function forwardError(c: Context, error: unknown) {
  consola.error('Error occurred:', error)

  if (error instanceof HTTPError) {
    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    }
    catch {
      errorJson = errorText
    }
    consola.error('HTTP error:', errorJson)
    if (isStructuredErrorPayload(errorJson)) {
      return c.json(
        errorJson,
        error.response.status as ContentfulStatusCode,
      )
    }
    return c.json(
      {
        error: {
          message: errorText,
          type: 'error',
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return c.json({ error: { message: 'Upstream request was aborted', type: 'timeout_error' } }, 504)
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: 'error',
      },
    },
    500,
  )
}

export function throwInvalidRequestError(
  message: string,
  param: string,
  code?: string,
): never {
  throw new HTTPError(
    message,
    Response.json(
      {
        error: {
          message,
          type: 'invalid_request_error',
          param,
          ...(code ? { code } : {}),
        },
      },
      { status: 400 },
    ),
  )
}

function isStructuredErrorPayload(
  value: unknown,
): value is { error: Record<string, unknown> } {
  return typeof value === 'object'
    && value !== null
    && 'error' in value
    && typeof value.error === 'object'
    && value.error !== null
}
