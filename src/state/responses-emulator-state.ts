import type {
  ResponseConversation,
  ResponseDeletionResult,
  ResponseInputItem,
  ResponsesResult,
} from '~/types'

import { configStore } from './config-store'

const DEFAULT_MAX_TOTAL_ENTRIES = 10_000
const BACKGROUND_PRUNE_INTERVAL_MS = 60_000

export type ResponsesEmulatorDeletionKind = 'response' | 'input_items'

interface StoredEntry<T> {
  expiresAt: number
  value: T
}

export interface ResponsesEmulatorDeletionFlag {
  deleted: true
  deletedAt: number
  expiresAt: number
}

export interface ResponsesEmulatorSnapshot {
  conversations: number
  conversationHeads: number
  deletions: number
  inputItems: number
  responses: number
}

export interface ResponsesEmulatorOptions {
  maxTotalEntries?: number
}

/** Per-write TTL override; falls back to the configured emulator TTL. */
interface TtlOptions {
  ttlSeconds?: number
}

/**
 * The store's shape is inferred from {@link createResponsesEmulatorState}'s
 * return value rather than declared separately, so the two cannot drift.
 */
export type ResponsesEmulatorState = ReturnType<typeof createResponsesEmulatorState>

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

function currentTime(): number {
  return Date.now()
}

function resolveTtlSeconds(ttlSeconds?: number): number {
  const resolved = ttlSeconds ?? configStore.getEmulatorTtlSeconds()
  if (!Number.isFinite(resolved) || resolved <= 0) {
    return configStore.getEmulatorTtlSeconds()
  }
  return Math.floor(resolved)
}

function toExpiresAt(ttlSeconds?: number, at = currentTime()): number {
  return at + resolveTtlSeconds(ttlSeconds) * 1000
}

function responseKeyFromConversation(conversation: ResponseConversation): string {
  return typeof conversation === 'string'
    ? conversation
    : conversation.id
}

export function createResponsesEmulatorState(opts?: ResponsesEmulatorOptions) {
  const maxTotalEntries = opts?.maxTotalEntries ?? DEFAULT_MAX_TOTAL_ENTRIES

  const responseRecords = new Map<string, StoredEntry<ResponsesResult>>()
  const conversationRecords = new Map<string, StoredEntry<ResponseConversation>>()
  const conversationHeadRecords = new Map<string, StoredEntry<string>>()
  const inputItemRecords = new Map<string, StoredEntry<Array<ResponseInputItem>>>()
  const responseDeletionFlags = new Map<string, StoredEntry<ResponsesEmulatorDeletionFlag>>()
  const inputItemDeletionFlags = new Map<string, StoredEntry<ResponsesEmulatorDeletionFlag>>()

  const allMaps: Array<Map<string, StoredEntry<unknown>>> = [
    responseRecords,
    conversationRecords,
    conversationHeadRecords,
    inputItemRecords,
    responseDeletionFlags,
    inputItemDeletionFlags,
  ] as Array<Map<string, StoredEntry<unknown>>>

  let pruneIntervalId: ReturnType<typeof setInterval> | undefined

  function startBackgroundPrune(): void {
    if (pruneIntervalId !== undefined)
      return
    pruneIntervalId = setInterval(pruneExpiredRecords, BACKGROUND_PRUNE_INTERVAL_MS)
    if (typeof pruneIntervalId === 'object' && 'unref' in pruneIntervalId) {
      pruneIntervalId.unref()
    }
  }

  function stopBackgroundPrune(): void {
    if (pruneIntervalId !== undefined) {
      clearInterval(pruneIntervalId)
      pruneIntervalId = undefined
    }
  }

  function totalEntries(): number {
    let sum = 0
    for (const map of allMaps) {
      sum += map.size
    }
    return sum
  }

  function pruneMap<T>(map: Map<string, StoredEntry<T>>, at = currentTime()): void {
    for (const [key, entry] of map) {
      if (entry.expiresAt <= at) {
        map.delete(key)
      }
    }
  }

  function readMap<T>(map: Map<string, StoredEntry<T>>, key: string, at = currentTime()): T | undefined {
    const entry = map.get(key)
    if (!entry) {
      return undefined
    }
    if (entry.expiresAt <= at) {
      map.delete(key)
      return undefined
    }
    return cloneValue(entry.value)
  }

  function writeMap<T>(
    map: Map<string, StoredEntry<T>>,
    key: string,
    value: T,
    ttlSeconds?: number,
    at = currentTime(),
  ): T {
    startBackgroundPrune()
    if (!map.has(key))
      enforceCapOnWrite()
    const cloned = cloneValue(value)
    map.set(key, {
      expiresAt: toExpiresAt(ttlSeconds, at),
      value: cloned,
    })
    return cloneValue(cloned)
  }

  function deleteMapEntry<T>(
    map: Map<string, StoredEntry<T>>,
    key: string,
  ): boolean {
    return map.delete(key)
  }

  function putDeletionFlag(
    map: Map<string, StoredEntry<ResponsesEmulatorDeletionFlag>>,
    id: string,
    ttlSeconds?: number,
    at = currentTime(),
  ): ResponsesEmulatorDeletionFlag {
    startBackgroundPrune()
    if (!map.has(id))
      enforceCapOnWrite()
    const flag: ResponsesEmulatorDeletionFlag = {
      deleted: true,
      deletedAt: at,
      expiresAt: toExpiresAt(ttlSeconds, at),
    }

    map.set(id, {
      expiresAt: flag.expiresAt,
      value: flag,
    })

    return cloneValue(flag)
  }

  function readDeletionFlag(
    map: Map<string, StoredEntry<ResponsesEmulatorDeletionFlag>>,
    id: string,
    at = currentTime(),
  ): ResponsesEmulatorDeletionFlag | undefined {
    return readMap(map, id, at)
  }

  function removeDeletionFlag(
    map: Map<string, StoredEntry<ResponsesEmulatorDeletionFlag>>,
    id: string,
  ): void {
    map.delete(id)
  }

  function deletionMap(kind: ResponsesEmulatorDeletionKind) {
    switch (kind) {
      case 'response':
        return responseDeletionFlags
      case 'input_items':
        return inputItemDeletionFlags
    }
  }

  function pruneExpiredRecords(at = currentTime()): void {
    pruneMap(responseRecords, at)
    pruneMap(conversationRecords, at)
    pruneMap(conversationHeadRecords, at)
    pruneMap(inputItemRecords, at)
    pruneMap(responseDeletionFlags, at)
    pruneMap(inputItemDeletionFlags, at)
  }

  function evictOldestFromLargestMap(): void {
    let largest: Map<string, StoredEntry<unknown>> | undefined
    let largestSize = 0
    for (const map of allMaps) {
      if (map.size > largestSize) {
        largestSize = map.size
        largest = map as Map<string, StoredEntry<unknown>>
      }
    }
    if (!largest || largestSize === 0)
      return

    let oldestKey: string | undefined
    let oldestExpires = Number.POSITIVE_INFINITY
    for (const [key, entry] of largest) {
      if (entry.expiresAt < oldestExpires) {
        oldestExpires = entry.expiresAt
        oldestKey = key
      }
    }
    if (oldestKey !== undefined) {
      largest.delete(oldestKey)
    }
  }

  function enforceCapOnWrite(): void {
    if (totalEntries() < maxTotalEntries)
      return
    pruneExpiredRecords()
    while (totalEntries() >= maxTotalEntries) {
      const sizeBefore = totalEntries()
      evictOldestFromLargestMap()
      if (totalEntries() >= sizeBefore)
        break
    }
  }

  return {
    clear() {
      responseRecords.clear()
      conversationRecords.clear()
      conversationHeadRecords.clear()
      inputItemRecords.clear()
      responseDeletionFlags.clear()
      inputItemDeletionFlags.clear()
      stopBackgroundPrune()
    },

    pruneExpired(nowValue?: number) {
      pruneExpiredRecords(nowValue ?? currentTime())
    },

    totalEntries,

    snapshot(nowValue?: number) {
      const at = nowValue ?? currentTime()
      pruneExpiredRecords(at)
      return {
        responses: responseRecords.size,
        conversations: conversationRecords.size,
        conversationHeads: conversationHeadRecords.size,
        inputItems: inputItemRecords.size,
        deletions:
          responseDeletionFlags.size
          + inputItemDeletionFlags.size,
      }
    },

    setResponse(response: ResponsesResult, options?: TtlOptions) {
      removeDeletionFlag(responseDeletionFlags, response.id)
      if (response.conversation !== undefined && response.conversation !== null) {
        const conversationId = responseKeyFromConversation(response.conversation)
        writeMap(conversationRecords, conversationId, response.conversation, options?.ttlSeconds)
        writeMap(conversationHeadRecords, conversationId, response.id, options?.ttlSeconds)
      }
      return writeMap(responseRecords, response.id, response, options?.ttlSeconds)
    },

    getResponse(responseId: string): ResponsesResult | undefined {
      if (readDeletionFlag(responseDeletionFlags, responseId)) {
        return undefined
      }
      return readMap(responseRecords, responseId)
    },

    deleteResponse(responseId: string, options?: TtlOptions): ResponseDeletionResult {
      pruneExpiredRecords()
      const existing = readMap(responseRecords, responseId)
      deleteMapEntry(responseRecords, responseId)
      deleteMapEntry(inputItemRecords, responseId)
      putDeletionFlag(responseDeletionFlags, responseId, options?.ttlSeconds)
      putDeletionFlag(inputItemDeletionFlags, responseId, options?.ttlSeconds)
      if (existing?.conversation) {
        const conversationId = responseKeyFromConversation(existing.conversation)
        const head = readMap(conversationHeadRecords, conversationId)
        if (head === responseId) {
          deleteMapEntry(conversationHeadRecords, conversationId)
        }
      }
      return {
        id: responseId,
        object: 'response.deleted',
        deleted: true,
      }
    },

    setConversation(conversation: ResponseConversation, options?: TtlOptions) {
      const conversationId = responseKeyFromConversation(conversation)
      return writeMap(conversationRecords, conversationId, conversation, options?.ttlSeconds)
    },

    getConversation(conversationId: string): ResponseConversation | undefined {
      return readMap(conversationRecords, conversationId)
    },

    setConversationHead(conversationId: string, responseId: string, options?: TtlOptions) {
      return writeMap(conversationHeadRecords, conversationId, responseId, options?.ttlSeconds)
    },

    getConversationHead(conversationId: string): string | undefined {
      return readMap(conversationHeadRecords, conversationId)
    },

    setInputItems(responseId: string, inputItems: Array<ResponseInputItem>, options?: TtlOptions) {
      removeDeletionFlag(inputItemDeletionFlags, responseId)
      return writeMap(inputItemRecords, responseId, inputItems, options?.ttlSeconds)
    },

    getInputItems(responseId: string): Array<ResponseInputItem> | undefined {
      if (readDeletionFlag(inputItemDeletionFlags, responseId)) {
        return undefined
      }
      return readMap(inputItemRecords, responseId)
    },

    getDeletionFlag(
      kind: ResponsesEmulatorDeletionKind,
      id: string,
    ): ResponsesEmulatorDeletionFlag | undefined {
      return readDeletionFlag(deletionMap(kind), id)
    },
  }
}

export const responsesEmulatorState = createResponsesEmulatorState()
