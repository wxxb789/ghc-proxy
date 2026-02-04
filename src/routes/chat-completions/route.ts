import { Hono } from "hono"

import { requestGuard } from "~/routes/middleware/request-guard"

import { handleCompletion } from "./handler"

export const completionRoutes = new Hono()

completionRoutes.post("/", requestGuard, (c) => handleCompletion(c))
