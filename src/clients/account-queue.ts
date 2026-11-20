import type { UpstreamRequestQueue, UpstreamRequestQueueOptions } from './upstream-queue'
import type { AccountRuntime } from '~/state/account-runtime'

interface AccountQueue {
  queue: UpstreamRequestQueue
  optionsRevision: number
}

const accountQueues = new WeakMap<AccountRuntime, AccountQueue>()
let queueOptionsRevision = 0
const lastDefinedQueueOptions: Record<keyof UpstreamRequestQueueOptions, { revision: number, value: number } | undefined> = {
  concurrency: undefined,
  maxRetries: undefined,
  baseDelayMs: undefined,
  maxDelayMs: undefined,
  maxQueueDepth: undefined,
  recoveryBudgetMs: undefined,
}
const queueOptionKeys = Object.keys(lastDefinedQueueOptions) as Array<keyof UpstreamRequestQueueOptions>

function queueOptionUpdatesSince(revision: number): Partial<UpstreamRequestQueueOptions> {
  const updates: Partial<UpstreamRequestQueueOptions> = {}
  for (const key of queueOptionKeys) {
    const update = lastDefinedQueueOptions[key]
    if (update && update.revision > revision)
      updates[key] = update.value
  }
  return updates
}

export function syncAccountQueueOptions(runtime: AccountRuntime): UpstreamRequestQueue | undefined {
  const entry = accountQueues.get(runtime)
  if (entry && entry.optionsRevision !== queueOptionsRevision) {
    const updates = queueOptionUpdatesSince(entry.optionsRevision)
    entry.optionsRevision = queueOptionsRevision
    entry.queue.updateOptions(updates)
  }
  return entry?.queue
}

export function getOrCreateAccountQueue(
  runtime: AccountRuntime,
  createQueue: (options: Partial<UpstreamRequestQueueOptions>) => UpstreamRequestQueue,
): UpstreamRequestQueue {
  const existing = syncAccountQueueOptions(runtime)
  if (existing)
    return existing

  const queue = createQueue(queueOptionUpdatesSince(0))
  accountQueues.set(runtime, { queue, optionsRevision: queueOptionsRevision })
  return queue
}

export function configureAccountQueueOptions(
  options: Partial<UpstreamRequestQueueOptions>,
  runtimes: Iterable<AccountRuntime>,
): void {
  queueOptionsRevision++
  for (const key of queueOptionKeys) {
    const value = options[key]
    if (value != null)
      lastDefinedQueueOptions[key] = { revision: queueOptionsRevision, value }
  }
  for (const runtime of runtimes)
    syncAccountQueueOptions(runtime)
}
