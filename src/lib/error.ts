import consola from 'consola'

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

/**
 * Framework-agnostic error response builder.
 * Returns a standard Response object using the Web API directly.
 */
export async function createErrorResponse(error: unknown): Promise<Response> {
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
      return Response.json(errorJson, { status: error.response.status })
    }
    return Response.json(
      {
        error: {
          message: errorText,
          type: 'error',
        },
      },
      { status: error.response.status },
    )
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return Response.json(
      { error: { message: 'Upstream request was aborted', type: 'timeout_error' } },
      { status: 504 },
    )
  }

  return Response.json(
    {
      error: {
        message: (error as Error).message,
        type: 'error',
      },
    },
    { status: 500 },
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
