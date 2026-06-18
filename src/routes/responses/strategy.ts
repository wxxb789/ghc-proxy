import type { CopilotClient } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'
import type { ExecutionStrategy, SSEStreamChunk } from '~/lib/execution-strategy'
import type { ResponsesPayload, ResponsesResult } from '~/types'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import consola from 'consola'

import { HTTPError } from '~/lib/error'
import { passthroughSSEChunk } from '~/lib/execution-strategy'
import { PATHS } from '~/lib/paths'
import { runtimeStore } from '~/state'
import { isAsyncIterable } from '~/util/async-iterable'

interface StreamIdState {
  responseId?: string
  itemIdsByOutputIndex: Map<number, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function createStreamIdTracker(): StreamIdState {
  return {
    itemIdsByOutputIndex: new Map(),
  }
}

function fixStreamIds(
  rawData: string,
  eventName: string | undefined,
  state: StreamIdState,
): string {
  if (!rawData) {
    return rawData
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawData) as Record<string, unknown>
  }
  catch {
    return rawData
  }

  const response = isRecord(parsed.response) ? parsed.response : undefined
  if (typeof response?.id === 'string') {
    if (!state.responseId) {
      state.responseId = response.id
    }
    else if (response.id !== state.responseId) {
      response.id = state.responseId
    }
  }

  if (eventName === 'response.output_item.added' || eventName === 'response.output_item.done') {
    const outputIndex = typeof parsed.output_index === 'number' ? parsed.output_index : undefined
    const item = isRecord(parsed.item) ? parsed.item : undefined
    if (outputIndex !== undefined && typeof item?.id === 'string') {
      const stableId = state.itemIdsByOutputIndex.get(outputIndex)
      if (!stableId) {
        state.itemIdsByOutputIndex.set(outputIndex, item.id)
      }
      else if (item.id !== stableId) {
        item.id = stableId
      }
    }
  }

  if (typeof parsed.output_index === 'number' && typeof parsed.item_id === 'string') {
    const stableId = state.itemIdsByOutputIndex.get(parsed.output_index)
    if (stableId && parsed.item_id !== stableId) {
      parsed.item_id = stableId
    }
  }

  return JSON.stringify(parsed)
}

export function createResponsesPassthroughStrategy(
  copilotClient: CopilotClient,
  payload: ResponsesPayload,
  options: {
    vision: boolean
    initiator: 'user' | 'agent'
    requestContext: Partial<CapiRequestContext>
    signal: AbortSignal
    mapResponse?: (response: ResponsesResult) => ResponsesResult
    onTerminalResponse?: (response: ResponsesResult) => void
  },
): ExecutionStrategy<ResponsesResult | AsyncIterable<SSEStreamChunk>, SSEStreamChunk> {
  const tracker = createStreamIdTracker()

  return {
    async execute() {
      try {
        return await copilotClient.createResponses(payload, options) as ResponsesResult | AsyncIterable<SSEStreamChunk>
      }
      catch (error) {
        if (runtimeStore.dumpFailedPayloads && error instanceof HTTPError && error.status === 400) {
          dumpFailedPayload(payload, error).catch(() => {})
        }
        throw error
      }
    },

    isStream(result): result is AsyncIterable<SSEStreamChunk> {
      return Boolean(payload.stream) && isAsyncIterable(result)
    },

    translateResult(result) {
      return result as ResponsesResult
    },

    translateStreamChunk(chunk) {
      const fixedData = fixStreamIds(chunk.data ?? '', chunk.event, tracker)
      const mappedData = options.mapResponse
        ? mapChunkResponse(fixedData, options.mapResponse)
        : fixedData
      const parsedResponse = tryExtractTerminalResponse(mappedData)
      if (parsedResponse) {
        options.onTerminalResponse?.(parsedResponse)
      }
      return passthroughSSEChunk(chunk, mappedData)
    },
  }
}

function mapChunkResponse(
  rawData: string,
  mapResponse: (response: ResponsesResult) => ResponsesResult,
): string {
  if (!rawData) {
    return rawData
  }

  try {
    const parsed = JSON.parse(rawData) as Record<string, unknown>
    if (isRecord(parsed.response)) {
      parsed.response = mapResponse(parsed.response as unknown as ResponsesResult)
      return JSON.stringify(parsed)
    }
  }
  catch {
  }

  return rawData
}

function tryExtractTerminalResponse(rawData: string): ResponsesResult | undefined {
  if (!rawData) {
    return undefined
  }

  try {
    const parsed = JSON.parse(rawData) as Record<string, unknown>
    if (
      parsed.type !== 'response.completed'
      && parsed.type !== 'response.incomplete'
      && parsed.type !== 'response.failed'
    ) {
      return undefined
    }

    const response = parsed.response
    if (response && typeof response === 'object') {
      return response as unknown as ResponsesResult
    }
  }
  catch {
  }

  return undefined
}

const MAX_DUMPS = 20
const TIMESTAMP_CHARS_RE = /[:.]/g
const DUMP_FILE_RE = /^\d{3}-/

async function dumpFailedPayload(payload: unknown, error: HTTPError): Promise<void> {
  try {
    const dumpDir = join(PATHS.APP_DIR, 'dumps')
    await mkdir(dumpDir, { recursive: true, mode: 0o700 })
    const now = new Date().toISOString()
    const ts = now.replace(TIMESTAMP_CHARS_RE, '-')
    const file = join(dumpDir, `${error.status}-${ts}.json`)
    await writeFile(file, JSON.stringify({
      timestamp: now,
      error: { status: error.status, message: error.message },
      payload,
    }, null, 2), { mode: 0o600 })
    consola.warn(`Dumped failed /responses payload → ${file}`)
    const files = await readdir(dumpDir)
    const dumps = files.filter(f => DUMP_FILE_RE.test(f) && f.endsWith('.json')).sort()
    if (dumps.length > MAX_DUMPS) {
      await Promise.all(dumps.slice(0, dumps.length - MAX_DUMPS).map(f => unlink(join(dumpDir, f)).catch(() => {})))
    }
  }
  catch {
    // Never let dump logic affect the request
  }
}
