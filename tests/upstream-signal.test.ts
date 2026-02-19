import { expect, test } from 'bun:test'

import { createUpstreamSignal } from '~/lib/upstream-signal'

test('returns a non-aborted signal initially', () => {
  const { signal } = createUpstreamSignal()
  expect(signal.aborted).toBe(false)
})

test('signal aborts after timeout expires', async () => {
  const { signal, cleanup } = createUpstreamSignal({ timeoutMs: 50 })
  expect(signal.aborted).toBe(false)

  await new Promise(resolve => setTimeout(resolve, 100))
  expect(signal.aborted).toBe(true)

  cleanup()
})

test('signal aborts when linked clientSignal aborts', async () => {
  const clientController = new AbortController()
  const { signal, cleanup } = createUpstreamSignal({
    clientSignal: clientController.signal,
    timeoutMs: 10_000,
  })

  expect(signal.aborted).toBe(false)
  clientController.abort()

  // Give the event listener time to fire
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(signal.aborted).toBe(true)

  cleanup()
})

test('does NOT abort when clientSignal is already aborted', () => {
  const clientController = new AbortController()
  clientController.abort()

  const { signal, cleanup } = createUpstreamSignal({
    clientSignal: clientController.signal,
    timeoutMs: 10_000,
  })

  // The key fix: signal should NOT inherit pre-aborted state
  expect(signal.aborted).toBe(false)

  cleanup()
})

test('cleanup clears the timeout', async () => {
  let aborted = false
  const { signal, cleanup } = createUpstreamSignal({ timeoutMs: 100 })

  signal.addEventListener('abort', () => {
    aborted = true
  })

  cleanup()
  await new Promise(resolve => setTimeout(resolve, 150))

  // Should not abort after cleanup
  expect(aborted).toBe(false)
})

test('works with no options (uses defaults)', () => {
  const { signal, cleanup } = createUpstreamSignal()
  expect(signal.aborted).toBe(false)
  cleanup()
})

test('works with only timeout option', async () => {
  const { signal, cleanup } = createUpstreamSignal({ timeoutMs: 50 })
  expect(signal.aborted).toBe(false)

  await new Promise(resolve => setTimeout(resolve, 100))
  expect(signal.aborted).toBe(true)

  cleanup()
})

test('works with only clientSignal option', async () => {
  const clientController = new AbortController()
  const { signal, cleanup } = createUpstreamSignal({
    clientSignal: clientController.signal,
  })

  expect(signal.aborted).toBe(false)
  clientController.abort()

  await new Promise(resolve => setTimeout(resolve, 10))
  expect(signal.aborted).toBe(true)

  cleanup()
})
