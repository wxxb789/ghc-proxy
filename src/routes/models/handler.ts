import { cacheModels, createCopilotClient } from '~/clients/factory'
import { modelCache } from '~/state'

/**
 * Core handler for listing models.
 */
export async function handleModelsCore(): Promise<object> {
  if (!modelCache.getModels()) {
    const copilotClient = createCopilotClient()
    await cacheModels(copilotClient)
  }

  const cached = modelCache.getModels()
  const models = cached?.data.map(model => ({
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
