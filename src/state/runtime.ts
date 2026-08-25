import { RequestActivityStore, sanitizeObservedError } from '~/observability/request-store'

export class RuntimeStore {
  dumpFailedPayloads = false
  readonly startedAt = new Date().toISOString()
  readonly requests = new RequestActivityStore()

  recordStreamError(requestId: string, error: unknown): void {
    this.requests.recordError(
      requestId,
      sanitizeObservedError(error, 'STREAM', 500),
    )
  }
}

export const runtimeStore = new RuntimeStore()
