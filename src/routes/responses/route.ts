import { Hono } from 'hono'

import { requestGuard } from '~/routes/middleware/request-guard'

import { handleResponses } from './handler'
import {
  handleCreateResponseInputTokens,
  handleDeleteResponse,
  handleListResponseInputItems,
  handleRetrieveResponse,
} from './resource-handler'

export const responsesRoutes = new Hono()

responsesRoutes.post('/', requestGuard, c => handleResponses(c))
responsesRoutes.post('/input_tokens', requestGuard, c => handleCreateResponseInputTokens(c))
responsesRoutes.get('/:responseId', requestGuard, c => handleRetrieveResponse(c))
responsesRoutes.get('/:responseId/input_items', requestGuard, c => handleListResponseInputItems(c))
responsesRoutes.delete('/:responseId', requestGuard, c => handleDeleteResponse(c))
