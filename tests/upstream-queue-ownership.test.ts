import type { AccountRuntime } from '~/state'

import { describe, expect, spyOn, test } from 'bun:test'
import {
  configureUpstreamRequestQueue,
  createCopilotClient,
  getUpstreamRequestQueueSnapshot,
} from '~/clients/factory'
import { UpstreamRequestQueue } from '~/clients/upstream-queue'
import { compileAccountRouting } from '~/lib/account-routing'
import {
  configureAccountRuntimes,
  createAccountRuntime,
  resetAccountRuntimes,
  runWithAccountRuntime,
} from '~/state'

import { buildGptModel, buildModelsResponse } from './helpers'

function holdModelsResponse() {
  const entered = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  return {
    entered: entered.promise,
    fetch: () => {
      entered.resolve()
      return response.promise
    },
    release: (model: string) => response.resolve(Response.json(buildModelsResponse(buildGptModel(model)))),
  }
}

function queueSnapshot(runtime: AccountRuntime) {
  return runWithAccountRuntime(runtime, getUpstreamRequestQueueSnapshot)
}

function publishQueueRuntimes(control: AccountRuntime, ...others: Array<AccountRuntime>) {
  const runtimes = [control, ...others]
  const names = runtimes.map(runtime => runtime.name)
  configureAccountRuntimes(compileAccountRouting({
    baseHostname: 'localhost',
    defaultAccount: control.name,
    hostnames: Object.fromEntries(names.map(name => [`${name}.localhost`, name])),
  }, names), runtimes)
}

describe('account queue ownership', () => {
  test('stops broadcasting updates to replaced and removed runtimes without moving their work', async () => {
    const unchanged = createAccountRuntime('default', { copilotToken: 'unchanged' })
    const previous = createAccountRuntime('work', { copilotToken: 'previous' })
    const previousResponse = holdModelsResponse()
    const unchangedResponse = holdModelsResponse()
    const originalFetch = globalThis.fetch
    const updateOptions = spyOn(UpstreamRequestQueue.prototype, 'updateOptions')
    const snapshot = spyOn(UpstreamRequestQueue.prototype, 'snapshot')

    function publish(work?: AccountRuntime) {
      const runtimes = work ? [unchanged, work] : [unchanged]
      configureAccountRuntimes(compileAccountRouting({
        baseHostname: 'localhost',
        defaultAccount: unchanged.name,
        hostnames: {
          'default.localhost': unchanged.name,
          ...(work ? { 'work.localhost': work.name } : {}),
        },
      }, runtimes.map(runtime => runtime.name)), runtimes)
    }

    globalThis.fetch = (async (_input, init) => {
      switch (new Headers(init?.headers).get('authorization')) {
        case 'Bearer previous':
          return previousResponse.fetch()
        case 'Bearer unchanged':
          return unchangedResponse.fetch()
        case 'Bearer replacement':
          return Response.json(buildModelsResponse(buildGptModel('replacement-model')))
        default:
          throw new Error('Unexpected upstream request in queue ownership test')
      }
    }) as typeof fetch

    const requestModels = (runtime: AccountRuntime) =>
      runWithAccountRuntime(runtime, () => createCopilotClient().getModels())

    try {
      configureUpstreamRequestQueue({ concurrency: 2, maxQueueDepth: 7 })
      publish(previous)
      const previousWork = requestModels(previous)
      const unchangedWork = requestModels(unchanged)
      await Promise.all([previousResponse.entered, unchangedResponse.entered])
      expect(queueSnapshot(previous)).toMatchObject({ active: 1, concurrency: 2, maxPending: 7 })

      for (let round = 0; round < 3; round++) {
        if (round > 0) {
          const next = createAccountRuntime('work')
          publish(next)
          expect(queueSnapshot(next)).toMatchObject({ active: 0, concurrency: 2, maxPending: 7 })
        }

        const replacement = createAccountRuntime('work', { copilotToken: 'replacement' })
        publish(replacement)
        expect(queueSnapshot(replacement)).toMatchObject({ active: 0, concurrency: 2, maxPending: 7 })
        if (round === 0)
          await expect(requestModels(replacement)).resolves.toMatchObject({ data: [{ id: 'replacement-model' }] })
        publish()
        expect(queueSnapshot(unchanged)).toMatchObject({ active: 1, concurrency: 2, maxPending: 7 })
      }

      expect(queueSnapshot(previous).active).toBe(1)
      previousResponse.release('previous-model')
      await expect(previousWork).resolves.toMatchObject({ data: [{ id: 'previous-model' }] })
      expect(queueSnapshot(previous).active).toBe(0)
      expect(queueSnapshot(unchanged).active).toBe(1)

      updateOptions.mockClear()
      configureUpstreamRequestQueue({ concurrency: 3 })
      expect(updateOptions).toHaveBeenCalledTimes(1)
      snapshot.mockClear()
      expect(queueSnapshot(unchanged)).toMatchObject({ active: 1, concurrency: 3, maxPending: 7 })
      const unchangedQueue = snapshot.mock.contexts[0]

      const newRuntime = createAccountRuntime('work')
      publish(newRuntime)
      expect(queueSnapshot(newRuntime)).toMatchObject({ active: 0, concurrency: 3, maxPending: 7 })
      const newQueue = snapshot.mock.contexts[1]

      updateOptions.mockClear()
      configureUpstreamRequestQueue({ maxQueueDepth: 8 })
      expect(updateOptions.mock.calls).toEqual([[{ maxQueueDepth: 8 }], [{ maxQueueDepth: 8 }]])
      expect(updateOptions.mock.contexts.filter(queue => queue === unchangedQueue)).toHaveLength(1)
      expect(updateOptions.mock.contexts.filter(queue => queue === newQueue)).toHaveLength(1)
      expect(queueSnapshot(newRuntime)).toMatchObject({ active: 0, concurrency: 3, maxPending: 8 })
      expect(queueSnapshot(unchanged)).toMatchObject({ active: 1, concurrency: 3, maxPending: 8 })

      unchangedResponse.release('unchanged-model')
      await expect(unchangedWork).resolves.toMatchObject({ data: [{ id: 'unchanged-model' }] })
      expect(queueSnapshot(unchanged).active).toBe(0)
    }
    finally {
      previousResponse.release('previous-model')
      unchangedResponse.release('unchanged-model')
      globalThis.fetch = originalFetch
      snapshot.mockRestore()
      updateOptions.mockRestore()
      configureUpstreamRequestQueue({ concurrency: 10, maxQueueDepth: 1_000 })
      resetAccountRuntimes()
    }
  })

  test('catches up a queue that missed an update before its runtime was published', () => {
    const control = createAccountRuntime('default')
    const runtime = createAccountRuntime('work')
    const updateOptions = spyOn(UpstreamRequestQueue.prototype, 'updateOptions')
    const snapshot = spyOn(UpstreamRequestQueue.prototype, 'snapshot')

    try {
      publishQueueRuntimes(control)
      configureUpstreamRequestQueue({ concurrency: 2 })
      expect(queueSnapshot(control).concurrency).toBe(2)
      const controlQueue = snapshot.mock.contexts[0]
      expect(queueSnapshot(runtime).concurrency).toBe(2)
      const warmedQueue = snapshot.mock.contexts[1] as UpstreamRequestQueue
      expect(warmedQueue).toBeInstanceOf(UpstreamRequestQueue)

      updateOptions.mockClear()
      configureUpstreamRequestQueue({ concurrency: 3 })
      expect(updateOptions).toHaveBeenCalledTimes(1)
      expect(updateOptions.mock.contexts[0]).toBe(controlQueue)
      publishQueueRuntimes(control, runtime)

      expect(warmedQueue.snapshot().concurrency).toBe(3)
      expect(queueSnapshot(runtime).concurrency).toBe(3)
      expect(updateOptions).toHaveBeenCalledTimes(2)
      expect(updateOptions.mock.contexts[1]).toBe(warmedQueue)
    }
    finally {
      snapshot.mockRestore()
      updateOptions.mockRestore()
      resetAccountRuntimes()
      configureUpstreamRequestQueue({ concurrency: 10 })
    }
  })

  test('preserves defined overrides when a later update explicitly passes undefined', () => {
    const control = createAccountRuntime('default')
    const warmed = createAccountRuntime('work')
    const fresh = createAccountRuntime('fresh')

    try {
      publishQueueRuntimes(control)
      configureUpstreamRequestQueue({ concurrency: 2, maxQueueDepth: 7 })
      expect(queueSnapshot(control)).toMatchObject({ concurrency: 2, maxPending: 7 })
      expect(queueSnapshot(warmed)).toMatchObject({ concurrency: 2, maxPending: 7 })

      configureUpstreamRequestQueue({ concurrency: 3 })
      configureUpstreamRequestQueue({ concurrency: undefined })
      expect(queueSnapshot(fresh)).toMatchObject({ concurrency: 3, maxPending: 7 })
      configureUpstreamRequestQueue({ maxQueueDepth: 8 })
      publishQueueRuntimes(control, warmed, fresh)

      expect(queueSnapshot(control)).toMatchObject({ concurrency: 3, maxPending: 8 })
      expect(queueSnapshot(warmed)).toMatchObject({ concurrency: 3, maxPending: 8 })
      expect(queueSnapshot(fresh)).toMatchObject({ concurrency: 3, maxPending: 8 })
    }
    finally {
      resetAccountRuntimes()
      configureUpstreamRequestQueue({ concurrency: 10, maxQueueDepth: 1_000 })
    }
  })
})
