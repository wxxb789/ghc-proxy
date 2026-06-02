import type { CopilotClient } from '~/clients'
import type { ResponsesPayload } from '~/types'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'

import { PATHS } from '~/lib/paths'
import { runtimeStore } from '~/state'
import { HTTPError } from '../src/lib/error'
import { createResponsesPassthroughStrategy } from '../src/routes/responses/strategy'

const payload: ResponsesPayload = {
  model: 'gpt-4.1',
  input: [{ type: 'message', role: 'user', content: 'secret prompt' }],
}

function createRejectingClient(error: HTTPError): CopilotClient {
  return {
    createResponses() {
      throw error
    },
  } as unknown as CopilotClient
}

function createStrategy(error: HTTPError) {
  return createResponsesPassthroughStrategy(createRejectingClient(error), payload, {
    vision: false,
    initiator: 'user',
    requestContext: {},
    signal: new AbortController().signal,
  })
}

async function withDumpEnvironment<T>(
  dumpFailedPayloads: boolean,
  run: (dumpDir: string) => Promise<T>,
): Promise<T> {
  const previousAppDir = PATHS.APP_DIR
  const previousDumpFailedPayloads = runtimeStore.dumpFailedPayloads
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghc-proxy-responses-dump-'))
  const dumpDir = path.join(tempDir, 'dumps')

  PATHS.APP_DIR = tempDir
  runtimeStore.dumpFailedPayloads = dumpFailedPayloads

  try {
    return await run(dumpDir)
  }
  finally {
    PATHS.APP_DIR = previousAppDir
    runtimeStore.dumpFailedPayloads = previousDumpFailedPayloads
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

async function listDumps(dumpDir: string): Promise<Array<string>> {
  try {
    return await fs.readdir(dumpDir)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

async function waitForDumps(dumpDir: string, expectedCount: number): Promise<Array<string>> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const dumps = await listDumps(dumpDir)
    if (dumps.length === expectedCount) {
      return dumps
    }
    await Bun.sleep(25)
  }
  return listDumps(dumpDir)
}

describe('responses failed payload dumps', () => {
  test('does not dump upstream 400 payloads by default', async () => {
    await withDumpEnvironment(false, async (dumpDir) => {
      const error = new HTTPError(400, {
        error: { message: 'Invalid request', type: 'invalid_request_error' },
      })
      const strategy = createStrategy(error)

      await expect(strategy.execute()).rejects.toBe(error)
      expect(await waitForDumps(dumpDir, 0)).toEqual([])
    })
  })

  test('dumps upstream 400 payloads when explicitly enabled', async () => {
    await withDumpEnvironment(true, async (dumpDir) => {
      const error = new HTTPError(400, {
        error: { message: 'Invalid request', type: 'invalid_request_error' },
      })
      const strategy = createStrategy(error)

      await expect(strategy.execute()).rejects.toBe(error)

      const dumps = await waitForDumps(dumpDir, 1)
      expect(dumps).toHaveLength(1)
      expect(dumps[0]?.startsWith('400-')).toBe(true)

      const dump = JSON.parse(await fs.readFile(path.join(dumpDir, dumps[0]!), 'utf8')) as {
        error: { status: number, message: string }
        payload: ResponsesPayload
      }
      expect(dump.error).toEqual({ status: 400, message: 'Invalid request' })
      expect(dump.payload).toEqual(payload)
    })
  })

  test('does not dump non-400 upstream errors even when enabled', async () => {
    await withDumpEnvironment(true, async (dumpDir) => {
      const error = new HTTPError(429, {
        error: { message: 'Rate limited', type: 'rate_limit_error' },
      })
      const strategy = createStrategy(error)

      await expect(strategy.execute()).rejects.toBe(error)
      expect(await waitForDumps(dumpDir, 0)).toEqual([])
    })
  })
})
