import { Hono } from 'hono'

import { CopilotClient } from '~/clients'
import { cacheModels, getClientConfig, state } from '~/lib/state'

/**
 * Framework-agnostic handler for listing models.
 */
export async function handleModelsCore(): Promise<object> {
  if (!state.cache.models) {
    // This should be handled by startup logic, but as a fallback.
    const copilotClient = new CopilotClient(state.auth, getClientConfig())
    await cacheModels(copilotClient)
  }

  const models = state.cache.models?.data.map(model => ({
    id: model.id,
    object: 'model',
    type: 'model',
    created: 0, // No date available from source
    created_at: new Date(0).toISOString(), // No date available from source
    owned_by: model.vendor,
    display_name: model.name,
  }))

  return {
    object: 'list',
    data: models,
    has_more: false,
  }
}

export const modelRoutes = new Hono()

modelRoutes.get('/', async (c) => {
  return c.json(await handleModelsCore())
})
