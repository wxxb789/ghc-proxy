import { Elysia } from 'elysia'

import { handleUsageCore } from './handler'

export { handleUsageCore } from './handler'

export const usageRoute = new Elysia()
  .get('/usage', async () => {
    return handleUsageCore()
  })
