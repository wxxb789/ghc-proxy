import { colorize } from 'consola/utils'

export type ModelTransformTag
  = | 'AUTO_CORRECT'
    | 'CONFIG_REWRITE'
    | 'COMPACT'
    | 'MODEL_RESOLVE'

export interface ModelTransformStep {
  tag: ModelTransformTag
  from: string
  to: string
}

export interface ModelMappingInfo {
  originalModel?: string
  steps: ModelTransformStep[]
}

/**
 * Per-request model mapping store.
 * Route handlers write to this; the after-response hook reads from it.
 * Uses WeakMap so entries are GC'd when the Request is collected.
 */
const requestModelMapping = new WeakMap<Request, ModelMappingInfo>()

export function setRequestModelMapping(request: Request, info: ModelMappingInfo): void {
  requestModelMapping.set(request, info)
}

export function getRequestModelMapping(request: Request): ModelMappingInfo | undefined {
  return requestModelMapping.get(request)
}

export function formatElapsed(start: number) {
  const delta = Date.now() - start
  return delta < 1000 ? `${delta}ms` : `${Math.round(delta / 1000)}s`
}

function formatPath(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    return `${url.pathname}${url.search}`
  }
  catch {
    return rawUrl
  }
}

function colorizeStatus(status: number): string {
  if (status >= 500)
    return colorize('red', status)
  if (status >= 400)
    return colorize('yellow', status)
  if (status >= 300)
    return colorize('cyan', status)
  return colorize('green', status)
}

const methodColors: Record<string, Parameters<typeof colorize>[0]> = {
  GET: 'cyan',
  POST: 'magenta',
  PUT: 'yellow',
  PATCH: 'yellow',
  DELETE: 'red',
}

function colorizeMethod(method: string): string {
  return colorize(methodColors[method] ?? 'white', method)
}

export function getEffectiveModel(info: ModelMappingInfo): string {
  return info.steps.length > 0
    ? info.steps.at(-1)!.to
    : info.originalModel ?? '-'
}

/**
 * Mutate `modelMapping` in place by appending a transform step.
 * Strategy contexts hold a reference to the same `modelMapping`,
 * so steps are pushed directly rather than returning a new object.
 */
export function appendModelStepInPlace(
  info: ModelMappingInfo,
  tag: ModelTransformTag,
  newModel: string,
): void {
  const current = getEffectiveModel(info)
  if (newModel !== current) {
    info.steps.push({ tag, from: current, to: newModel })
  }
}

function formatModelMapping(info: ModelMappingInfo | undefined): string {
  if (!info)
    return ''

  const { originalModel, steps } = info
  if (!originalModel && steps.length === 0)
    return ''

  const display = originalModel ?? '-'
  const parts: string[] = [colorize('blueBright', display)]

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const isLast = i === steps.length - 1
    parts.push(colorize('dim', `-[${step.tag}]->`))
    parts.push(colorize(isLast ? 'greenBright' : 'cyanBright', step.to))
  }

  return ` ${colorize('dim', 'model=')}${parts.join(' ')}`
}

/**
 * Request logging function.
 * Logs a formatted request line with method, path, status, elapsed time,
 * and optional model mapping info.
 */
export function logRequest(
  method: string,
  url: string,
  status: number,
  elapsed: string,
  modelInfo?: ModelMappingInfo,
  requestId?: string,
): void {
  const path = formatPath(url)
  const line = [
    colorize('dim', '<-'),
    colorizeMethod(method),
    colorize('white', path),
    colorizeStatus(status),
    colorize('dim', elapsed),
  ].join(' ')

  const rid = requestId ? ` ${colorize('dim', `rid=${requestId.slice(0, 8)}`)}` : ''

  // eslint-disable-next-line no-console
  console.log(`${line}${formatModelMapping(modelInfo)}${rid}`)
}
