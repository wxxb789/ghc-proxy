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
 * Strategy runner. Returns a discriminated union
 * instead of a framework-specific Response.
 */
export async function runStrategy<TResult, TChunk>(
  strategy: ExecutionStrategy<TResult, TChunk>,
  signal: { signal: AbortSignal, clientSignal?: AbortSignal, cleanup: () => void },
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
      // Only suppress error events when the *client* disconnected.
      // Upstream timeouts (proxy-side abort) should still emit onStreamError
      // so strategies can translate them into proper SSE error events.
      if (!signal.clientSignal?.aborted) {
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

function normalizeOutputs(value: SSEOutput | SSEOutput[] | null): SSEOutput[] {
  if (!value) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

/**
 * Creates an SSEOutput by copying SSE metadata fields from a raw chunk
 * and replacing the data field with the provided value.
 */
export function passthroughSSEChunk(chunk: SSEStreamChunk, data: string): SSEOutput {
  return {
    ...(chunk.comment ? { comment: chunk.comment } : {}),
    ...(chunk.event ? { event: chunk.event } : {}),
    ...(chunk.id !== undefined ? { id: String(chunk.id) } : {}),
    ...(chunk.retry !== undefined ? { retry: chunk.retry } : {}),
    data,
  }
}
