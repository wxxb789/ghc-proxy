import { Elysia } from 'elysia'

import { handleTokenCore } from './handler'

export function createTokenRoute() {
  return new Elysia()
    .get('/token', () => handleTokenCore())
}
