import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

export type ModelMappingInfo = {
  originalModel?: string
  mappedModel?: string
}

const formatElapsed = (start: number) => {
  const delta = Date.now() - start
  return delta < 1000 ? `${delta}ms` : `${Math.round(delta / 1000)}s`
}

const formatPath = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl)
    return `${url.pathname}${url.search}`
  } catch {
    return rawUrl
  }
}

const formatModelMappingSuffix = (info: ModelMappingInfo | undefined) => {
  if (!info) {
    return ""
  }

  const { originalModel, mappedModel } = info

  if (!originalModel && !mappedModel) {
    return ""
  }

  return ` original_model=${originalModel ?? "-"} copilot_model=${mappedModel ?? "-"}`
}

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const { method, url } = c.req
  const path = formatPath(url)
  const start = Date.now()

  try {
    await next()
  } finally {
    const elapsed = formatElapsed(start)
    const status = c.res.status
    const modelInfo = c.get("modelMappingInfo")
    consola.info(
      `${method} ${path} ${status} ${elapsed}${formatModelMappingSuffix(modelInfo)}`,
    )
  }
}

export const setModelMappingInfo = (c: Context, info: ModelMappingInfo) => {
  c.set("modelMappingInfo", info)
}
