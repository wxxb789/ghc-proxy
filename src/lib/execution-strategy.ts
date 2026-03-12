import type { Context } from 'hono'

import { streamSSE } from 'hono/streaming'

export interface SSEOutput {
  id?: string
  event?: string
  data: string
  comment?: string
  retry?: number
}

export interface SSEStreamChunk {
  id?: number | string
  event?: string
  data?: string
  comment?: string
  retry?: number
}

export type ExecutionResult
  = | { kind: 'json', data: unknown }
    | { kind: 'stream', generator: AsyncGenerator<SSEOutput> }

export interface ExecutionStrategy<TResult, TChunk> {
  execute: () => Promise<TResult>
  isStream: (result: TResult) => result is TResult & AsyncIterable<TChunk>
  translateResult: (result: TResult) => unknown
  translateStreamChunk: (chunk: TChunk) => SSEOutput | SSEOutput[] | null
  onStreamDone?: () => SSEOutput | SSEOutput[] | null
  onStreamError?: (error: unknown) => SSEOutput | SSEOutput[] | null
  shouldBreakStream?: (chunk: TChunk) => boolean
}

/**
 * Framework-agnostic strategy runner. Returns a discriminated union
 * instead of a framework-specific Response.
 */
export async function runStrategy<TResult, TChunk>(
  strategy: ExecutionStrategy<TResult, TChunk>,
  signal: { signal: AbortSignal, cleanup: () => void },
): Promise<ExecutionResult> {
  const result = await strategy.execute()

  if (!strategy.isStream(result)) {
    signal.cleanup()
    return { kind: 'json', data: strategy.translateResult(result) }
  }

  async function* generateSSE(): AsyncGenerator<SSEOutput> {
    try {
      for await (const chunk of result as AsyncIterable<TChunk>) {
        const outputs = normalizeOutputs(strategy.translateStreamChunk(chunk))
        for (const output of outputs) {
          yield output
        }
        if (strategy.shouldBreakStream?.(chunk as TChunk)) {
          break
        }
      }
      const doneOutputs = normalizeOutputs(strategy.onStreamDone?.() ?? null)
      for (const output of doneOutputs) {
        yield output
      }
    }
    catch (error) {
      if (!signal.signal.aborted) {
        const errOutputs = normalizeOutputs(strategy.onStreamError?.(error) ?? null)
        for (const output of errOutputs) {
          yield output
        }
      }
    }
    finally {
      signal.cleanup()
    }
  }

  return { kind: 'stream', generator: generateSSE() }
}

/**
 * Hono-specific wrapper around runStrategy. Converts ExecutionResult
 * to a Hono Response using c.json() or streamSSE().
 */
export async function executeStrategy<TResult, TChunk>(
  c: Context,
  strategy: ExecutionStrategy<TResult, TChunk>,
  signal: { signal: AbortSignal, cleanup: () => void },
): Promise<Response> {
  const executionResult = await runStrategy(strategy, signal)

  if (executionResult.kind === 'json') {
    return c.json(executionResult.data)
  }

  return streamSSE(c, async (stream) => {
    for await (const output of executionResult.generator) {
      await stream.writeSSE(output)
    }
  })
}

function normalizeOutputs(value: SSEOutput | SSEOutput[] | null): SSEOutput[] {
  if (!value) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}
