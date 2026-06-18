import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'

import { createResponsesEmulatorState } from '~/state/responses-emulator-state'

import { buildResponsesResult } from './helpers'

describe('responses emulator state', () => {
  afterEach(() => {
    setSystemTime()
  })

  test('clones stored responses and input items on read and write', () => {
    const state = createResponsesEmulatorState()
    const response = buildResponsesResult({
      id: 'resp_1',
      conversation: { id: 'conv_1' },
    })

    state.setResponse(response)
    state.setInputItems('resp_1', [
      { type: 'message', role: 'user', content: 'hello' },
    ])

    const storedResponse = state.getResponse('resp_1')
    const storedInputItems = state.getInputItems('resp_1')

    expect(storedResponse).toMatchObject({
      id: 'resp_1',
      conversation: { id: 'conv_1' },
    })
    expect(storedInputItems).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
    ])

    if (storedResponse) {
      storedResponse.output_text = 'mutated'
    }
    if (storedInputItems) {
      storedInputItems[0] = { type: 'message', role: 'user', content: 'changed' }
    }

    expect(state.getResponse('resp_1')?.output_text).toBe('')
    expect(state.getInputItems('resp_1')).toEqual([
      { type: 'message', role: 'user', content: 'hello' },
    ])
  })

  test('tracks conversation heads and clears them when the head response is deleted', () => {
    const state = createResponsesEmulatorState()

    state.setResponse(buildResponsesResult({
      id: 'resp_1',
      conversation: { id: 'conv_1' },
    }))
    state.setResponse(buildResponsesResult({
      id: 'resp_2',
      conversation: { id: 'conv_1' },
    }))

    expect(state.getConversation('conv_1')).toEqual({ id: 'conv_1' })
    expect(state.getConversationHead('conv_1')).toBe('resp_2')

    state.deleteResponse('resp_2')

    expect(state.getConversationHead('conv_1')).toBeUndefined()
    expect(state.getConversation('conv_1')).toEqual({ id: 'conv_1' })
  })

  test('expires deletion flags and stored entries after ttl elapses', () => {
    const state = createResponsesEmulatorState()
    const baseTime = new Date('2026-04-02T00:00:00.000Z')
    setSystemTime(baseTime)

    state.setResponse(buildResponsesResult({
      id: 'resp_1',
      conversation: { id: 'conv_1' },
    }), { ttlSeconds: 1 })
    state.setInputItems('resp_1', [
      { type: 'message', role: 'user', content: 'hello' },
    ], { ttlSeconds: 1 })

    state.deleteResponse('resp_1', { ttlSeconds: 1 })

    expect(state.getResponse('resp_1')).toBeUndefined()
    expect(state.getInputItems('resp_1')).toBeUndefined()
    expect(state.getDeletionFlag('response', 'resp_1')).toBeDefined()
    expect(state.getDeletionFlag('input_items', 'resp_1')).toBeDefined()

    setSystemTime(new Date(baseTime.getTime() + 1500))
    state.pruneExpired()

    expect(state.getResponse('resp_1')).toBeUndefined()
    expect(state.getInputItems('resp_1')).toBeUndefined()
    expect(state.getDeletionFlag('response', 'resp_1')).toBeUndefined()
    expect(state.getDeletionFlag('input_items', 'resp_1')).toBeUndefined()
    expect(state.snapshot()).toEqual({
      responses: 0,
      conversations: 0,
      conversationHeads: 0,
      inputItems: 0,
      deletions: 0,
    })
  })

  test('enforces memory cap across multi-entry setResponse writes', () => {
    const state = createResponsesEmulatorState({ maxTotalEntries: 10 })

    for (let i = 0; i < 20; i++) {
      state.setResponse(buildResponsesResult({
        id: `resp_${i}`,
        conversation: { id: `conv_${i}` },
      }))
    }

    expect(state.totalEntries()).toBeLessThanOrEqual(10)
  })

  test('enforces memory cap when deletion flags are added', () => {
    const state = createResponsesEmulatorState({ maxTotalEntries: 10 })

    for (let i = 0; i < 5; i++) {
      state.setResponse(buildResponsesResult({
        id: `resp_${i}`,
        conversation: { id: `conv_${i}` },
      }))
    }

    for (let i = 0; i < 20; i++) {
      state.deleteResponse(`resp_del_${i}`)
    }

    expect(state.totalEntries()).toBeLessThanOrEqual(10)
  })

  test('skips cap enforcement for key updates that do not grow entry count', () => {
    const state = createResponsesEmulatorState({ maxTotalEntries: 6 })

    for (let i = 0; i < 2; i++) {
      state.setResponse(buildResponsesResult({
        id: `resp_${i}`,
        conversation: { id: `conv_${i}` },
      }))
    }

    const beforeUpdate = state.totalEntries()

    state.setResponse(buildResponsesResult({
      id: 'resp_0',
      conversation: { id: 'conv_0' },
    }))

    expect(state.totalEntries()).toBe(beforeUpdate)
  })

  test('keeps separate instances isolated and clearable', () => {
    const first = createResponsesEmulatorState()
    const second = createResponsesEmulatorState()

    first.setResponse(buildResponsesResult({
      id: 'resp_1',
      conversation: { id: 'conv_1' },
    }))
    second.setResponse(buildResponsesResult({
      id: 'resp_2',
      conversation: { id: 'conv_2' },
    }))

    expect(first.getResponse('resp_2')).toBeUndefined()
    expect(second.getResponse('resp_1')).toBeUndefined()
    expect(first.snapshot().responses).toBe(1)
    expect(second.snapshot().responses).toBe(1)

    first.clear()
    expect(first.snapshot()).toEqual({
      responses: 0,
      conversations: 0,
      conversationHeads: 0,
      inputItems: 0,
      deletions: 0,
    })
  })
})
