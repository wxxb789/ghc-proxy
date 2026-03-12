import { Elysia } from 'elysia'

import { handleTokenCore } from './handler'

export { handleTokenCore } from './handler'

export const tokenRoute = new Elysia()
  .get('/token', () => {
    return handleTokenCore()
  })
