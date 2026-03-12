import { Elysia } from 'elysia'

import { handleUsageCore } from './handler'

export function createUsageRoute() {
  return new Elysia()
    .get('/usage', async () => handleUsageCore())
}
