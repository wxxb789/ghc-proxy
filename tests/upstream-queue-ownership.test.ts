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

describe('account queue ownership', () => {
  test('stops broadcasting updates to replaced and removed runtimes without moving their work', async () => {
    const unchanged = createAccountRuntime('default', { copilotToken: 'unchanged' })
    const previous = createAccountRuntime('work', { copilotToken: 'previous' })
    const previousResponse = holdModelsResponse()
    const unchangedResponse = holdModelsResponse()
    const originalFetch = globalThis.fetch
    const updateOptions = spyOn(UpstreamRequestQueue.prototype, 'updateOptions')

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
      expect(queueSnapshot(unchanged)).toMatchObject({ active: 1, concurrency: 3, maxPending: 7 })

      const newRuntime = createAccountRuntime('work')
      publish(newRuntime)
      expect(queueSnapshot(newRuntime)).toMatchObject({ active: 0, concurrency: 3, maxPending: 7 })
      configureUpstreamRequestQueue({ maxQueueDepth: 8 })
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
      updateOptions.mockRestore()
      configureUpstreamRequestQueue({ concurrency: 10, maxQueueDepth: 1_000 })
      resetAccountRuntimes()
    }
  })

  test('catches up a queue that missed an update before its runtime was published', () => {
    const runtime = createAccountRuntime('work')
    const updateOptions = spyOn(UpstreamRequestQueue.prototype, 'updateOptions')

    try {
      configureUpstreamRequestQueue({ concurrency: 2 })
      expect(queueSnapshot(runtime).concurrency).toBe(2)

      updateOptions.mockClear()
      configureUpstreamRequestQueue({ concurrency: 3 })
      expect(updateOptions).not.toHaveBeenCalled()
      configureAccountRuntimes(compileAccountRouting({
        baseHostname: 'localhost',
        defaultAccount: runtime.name,
        hostnames: { 'work.localhost': runtime.name },
      }, [runtime.name]), [runtime])

      expect(queueSnapshot(runtime).concurrency).toBe(3)
      expect(updateOptions).toHaveBeenCalledTimes(1)
    }
    finally {
      updateOptions.mockRestore()
      resetAccountRuntimes()
      configureUpstreamRequestQueue({ concurrency: 10 })
    }
  })
})
