import { Hono } from "hono"

import { requestGuard } from "~/routes/middleware/request-guard"

import { handleCountTokens } from "./count-tokens-handler"
import { handleCompletion } from "./handler"

export const messageRoutes = new Hono()

messageRoutes.post("/", requestGuard, (c) => handleCompletion(c))

messageRoutes.post("/count_tokens", (c) => handleCountTokens(c))
