import { z } from 'zod'

export const M365_DEFAULT_ENDPOINT = 'https://df.loki.delve.office.com/api/v1/llmapi'

export const M365_BUILTIN_ENDPOINTS: readonly string[] = [
  M365_DEFAULT_ENDPOINT,
  'https://msit.loki.delve.office.com/api/v1/llmapi',
]

const TRAILING_SLASHES_RE = /\/+$/

export const m365EndpointSchema = z.string().trim().url().refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !value.includes('?')
      && !value.includes('#')
  }
  catch {
    return false
  }
}, 'M365 endpoints must use HTTPS without credentials, a query, or a fragment.').transform(value => value.replace(TRAILING_SLASHES_RE, ''))
