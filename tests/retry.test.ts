import { describe, expect, mock, test } from 'bun:test'

import { HTTPError } from '../src/lib/error'

const sleepMock = mock((_ms: number) => Promise.resolve())
await mock.module('../src/util/sleep', () => ({
  sleep: sleepMock,
}))

const { retryWithBackoff, formatErrorMessage } = await import('../src/lib/retry')

describe('retryWithBackoff', () => {
  test('returns result on first success', async () => {
    sleepMock.mockClear()
    const fn = mock(() => Promise.resolve('ok'))

    const result = await retryWithBackoff(fn)

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
  })

  test('retries on transient error then succeeds', async () => {
    sleepMock.mockClear()
    let calls = 0
    const fn = mock(() => {
      calls++
      if (calls <= 2)
        throw new Error('network failure')
      return Promise.resolve('recovered')
    })

    const result = await retryWithBackoff(fn)

    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(sleepMock).toHaveBeenCalledTimes(2)
    expect(sleepMock.mock.calls[0]![0]).toBe(5_000)
    expect(sleepMock.mock.calls[1]![0]).toBe(10_000)
  })

  test('exhausts all retries then throws', async () => {
    sleepMock.mockClear()
    const error = new Error('persistent failure')
    const fn = mock(() => Promise.reject(error))

    await expect(retryWithBackoff(fn, { maxRetries: 3 })).rejects.toThrow('persistent failure')

    expect(fn).toHaveBeenCalledTimes(4) // 1 initial + 3 retries
    expect(sleepMock).toHaveBeenCalledTimes(3)
    expect(sleepMock.mock.calls[0]![0]).toBe(5_000)
    expect(sleepMock.mock.calls[1]![0]).toBe(10_000)
    expect(sleepMock.mock.calls[2]![0]).toBe(20_000)
  })

  test('skips retry when shouldRetry returns false', async () => {
    sleepMock.mockClear()
    const httpError = new HTTPError(401, {
      error: { message: 'Unauthorized', type: 'auth_error' },
    })
    const fn = mock(() => Promise.reject(httpError))

    await expect(
      retryWithBackoff(fn, { shouldRetry: e => !(e instanceof HTTPError) }),
    ).rejects.toThrow(httpError)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
  })

  test('calls onRetry callback before each retry', async () => {
    sleepMock.mockClear()
    let calls = 0
    const fn = mock(() => {
      calls++
      if (calls <= 2)
        throw new Error('fail')
      return Promise.resolve('ok')
    })
    const onRetry = mock((_error: unknown, _attempt: number, _delayMs: number) => {})

    await retryWithBackoff(fn, { onRetry })

    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry.mock.calls[0]![1]).toBe(0) // attempt 0
    expect(onRetry.mock.calls[0]![2]).toBe(5_000) // delay
    expect(onRetry.mock.calls[1]![1]).toBe(1) // attempt 1
    expect(onRetry.mock.calls[1]![2]).toBe(10_000) // delay
  })

  test('respects custom baseDelayMs', async () => {
    sleepMock.mockClear()
    let calls = 0
    const fn = mock(() => {
      calls++
      if (calls <= 1)
        throw new Error('fail')
      return Promise.resolve('ok')
    })

    await retryWithBackoff(fn, { baseDelayMs: 1_000 })

    expect(sleepMock.mock.calls[0]![0]).toBe(1_000)
  })
})

describe('formatErrorMessage', () => {
  test('extracts message from Error', () => {
    expect(formatErrorMessage(new Error('test'))).toBe('test')
  })

  test('converts non-Error to string', () => {
    expect(formatErrorMessage('raw string')).toBe('raw string')
    expect(formatErrorMessage(42)).toBe('42')
    expect(formatErrorMessage(null)).toBe('null')
  })
})
