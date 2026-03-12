import type { ExecutionStrategy, SSEOutput } from '~/lib/execution-strategy'

import { describe, expect, test } from 'bun:test'

import { runStrategy } from '~/lib/execution-strategy'

/**
 * Creates a stream that throws an AbortError after the signal is aborted.
 * This simulates an upstream fetch that fails because the proxy timeout fired.
 */
function createAbortingStream(signal: AbortSignal): AsyncIterable<string> & AsyncGenerator<string> {
  return (async function* () {
    // Wait for the signal to actually abort before throwing
    if (!signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    throw new DOMException('The operation was aborted.', 'AbortError')
  })()
}

function makeStrategy(stream: AsyncIterable<string> & AsyncGenerator<string>): ExecutionStrategy<AsyncIterable<string>, string> {
  return {
    execute: () => Promise.resolve(stream),
    isStream: (_result): _result is AsyncIterable<string> & AsyncIterable<string> => true,
    translateResult: () => null,
    translateStreamChunk: (chunk: string) => ({ data: chunk, event: 'data' }),
    onStreamDone: () => ({ data: '[DONE]', event: 'done' }),
    onStreamError: (error: unknown) => ({
      data: JSON.stringify({
        error: {
          message: error instanceof DOMException ? 'Upstream timeout' : 'Unknown error',
          type: 'timeout_error',
        },
      }),
      event: 'error',
    }),
  }
}

async function collectOutputs(generator: AsyncGenerator<SSEOutput>): Promise<SSEOutput[]> {
  const outputs: SSEOutput[] = []
  for await (const output of generator) {
    outputs.push(output)
  }
  return outputs
}

describe('runStrategy abort signal behavior', () => {
  test('emits onStreamError when proxy timeout aborts but client is still connected', async () => {
    // Simulate proxy timeout: the combined signal is aborted,
    // but the client signal is NOT aborted (client is still connected).
    const proxyController = new AbortController()
    const clientController = new AbortController()
    const stream = createAbortingStream(proxyController.signal)

    const signal = {
      signal: proxyController.signal,
      clientSignal: clientController.signal,
      cleanup: () => {},
    }

    const result = await runStrategy(makeStrategy(stream), signal)
    expect(result.kind).toBe('stream')
    if (result.kind !== 'stream')
      return

    // Fire the proxy timeout
    proxyController.abort()

    const outputs = await collectOutputs(result.generator)

    // Should have the error event because client is still connected
    const errorOutput = outputs.find(o => o.event === 'error')
    expect(errorOutput).toBeDefined()
    expect(errorOutput!.data).toContain('Upstream timeout')
  })

  test('suppresses onStreamError when client disconnects', async () => {
    // Simulate client disconnect: the client signal IS aborted.
    const proxyController = new AbortController()
    const clientController = new AbortController()
    const stream = createAbortingStream(proxyController.signal)

    const signal = {
      signal: proxyController.signal,
      clientSignal: clientController.signal,
      cleanup: () => {},
    }

    const result = await runStrategy(makeStrategy(stream), signal)
    expect(result.kind).toBe('stream')
    if (result.kind !== 'stream')
      return

    // Client disconnects, then proxy abort follows
    clientController.abort()
    proxyController.abort()

    const outputs = await collectOutputs(result.generator)

    // Should NOT have the error event because client disconnected
    const errorOutput = outputs.find(o => o.event === 'error')
    expect(errorOutput).toBeUndefined()
  })
})
