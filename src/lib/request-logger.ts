import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"
import { colorize } from "consola/utils"

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

const colorizeStatus = (status: number): string => {
  if (status >= 500) return colorize("red", status)
  if (status >= 400) return colorize("yellow", status)
  if (status >= 300) return colorize("cyan", status)
  return colorize("green", status)
}

const methodColors: Record<string, Parameters<typeof colorize>[0]> = {
  GET: "cyan",
  POST: "magenta",
  PUT: "yellow",
  PATCH: "yellow",
  DELETE: "red",
}

const colorizeMethod = (method: string): string =>
  colorize(methodColors[method] ?? "white", method)

const formatModelMapping = (info: ModelMappingInfo | undefined): string => {
  if (!info) return ""

  const { originalModel, mappedModel } = info
  if (!originalModel && !mappedModel) return ""

  const original = originalModel ?? "-"
  const mapped = mappedModel ?? "-"

  if (original === mapped) {
    return ` ${colorize("dim", "model=")}${colorize("blueBright", original)}`
  }

  return ` ${colorize("dim", "model=")}${colorize("blueBright", original)} ${colorize("dim", "→")} ${colorize("greenBright", mapped)}`
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

    const line = [
      colorizeMethod(method),
      colorize("white", path),
      colorizeStatus(status),
      colorize("dim", elapsed),
    ].join(" ")

    consola.info(`${line}${formatModelMapping(modelInfo)}`)
  }
}

export const setModelMappingInfo = (c: Context, info: ModelMappingInfo) => {
  c.set("modelMappingInfo", info)
}
