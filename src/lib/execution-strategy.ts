import type { Context } from 'hono'

import { streamSSE } from 'hono/streaming'

export interface SSEOutput {
  id?: string
  event?: string
  data: string
  comment?: string
  retry?: number
}

export interface ExecutionStrategy<TResult, TChunk> {
  execute: () => Promise<TResult>
  isStream: (result: TResult) => result is TResult & AsyncIterable<TChunk>
  translateResult: (result: TResult) => unknown
  translateStreamChunk: (chunk: TChunk) => SSEOutput | SSEOutput[] | null
  onStreamDone?: () => SSEOutput | SSEOutput[] | null
  onStreamError?: (error: unknown) => SSEOutput | SSEOutput[] | null
  shouldBreakStream?: (chunk: TChunk) => boolean
}

export async function executeStrategy<TResult, TChunk>(
  c: Context,
  strategy: ExecutionStrategy<TResult, TChunk>,
  signal: { signal: AbortSignal, cleanup: () => void },
): Promise<Response> {
  const result = await strategy.execute()

  if (!strategy.isStream(result)) {
    signal.cleanup()
    return c.json(strategy.translateResult(result))
  }

  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of result) {
        const outputs = normalizeOutputs(strategy.translateStreamChunk(chunk))
        for (const output of outputs) {
          await stream.writeSSE(output)
        }
        if (strategy.shouldBreakStream?.(chunk)) {
          break
        }
      }
      const doneOutputs = normalizeOutputs(strategy.onStreamDone?.() ?? null)
      for (const output of doneOutputs) {
        await stream.writeSSE(output)
      }
    }
    catch (error) {
      if (!c.req.raw.signal.aborted) {
        const errOutputs = normalizeOutputs(strategy.onStreamError?.(error) ?? null)
        for (const output of errOutputs) {
          await stream.writeSSE(output)
        }
      }
    }
    finally {
      signal.cleanup()
    }
  })
}

function normalizeOutputs(value: SSEOutput | SSEOutput[] | null): SSEOutput[] {
  if (!value) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}
