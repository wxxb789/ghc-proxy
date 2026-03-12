import consola from 'consola'

import { HTTPError } from './error'

export async function awaitApproval() {
  const response = await consola.prompt(`Accept incoming request?`, {
    type: 'confirm',
  })

  if (!response) {
    throw new HTTPError(403, {
      error: { message: 'Request rejected', type: 'forbidden' },
    })
  }
}
