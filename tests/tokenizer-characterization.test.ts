import type { CapiChatCompletionsPayload } from '~/core/capi'
import type { Model } from '~/types'

import { Buffer } from 'node:buffer'
import { unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, test } from 'bun:test'
import { tokenizerBlockPlugin } from './fixtures/tokenizer-cost'

interface TokenizerProbeResult {
  encodeCalls: number
  encodingLoads: number
}

interface CapturedCall {
  maxTokens?: number
  model: string
  stream?: boolean
  toolCount: number
}

const expectedUsage = {
  prompt_tokens: 7,
  completion_tokens: 1,
  total_tokens: 8,
  prompt_tokens_details: { cached_tokens: 3 },
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const probeGlobal = globalThis as typeof globalThis & {
  __tokenizerProbeState?: TokenizerProbeResult
}

interface EncodingImportCase {
  name: string
  input: string
  expected: TokenizerProbeResult
}

const encodingImportCases: EncodingImportCase[] = [
  {
    name: 'package specifier',
    input: 'gpt-tokenizer/encoding/o200k_base',
    expected: { encodingLoads: 1, encodeCalls: 1 },
  },
  {
    name: 'Windows absolute path',
    input: join(repositoryRoot, 'node_modules/gpt-tokenizer/encoding/o200k_base'),
    expected: { encodingLoads: 1, encodeCalls: 1 },
  },
]

if (process.env.GHC_TOKENIZER_PROBE_CHILD === '1') {
  await runProbe()
}
else {
  describe('tokenizer characterization', () => {
    test.each(encodingImportCases)('encoding interceptor catches $name', async ({ input, expected }) => {
      const previousState = probeGlobal.__tokenizerProbeState
      probeGlobal.__tokenizerProbeState = { encodeCalls: 0, encodingLoads: 0 }
      try {
        const build = await Bun.build({
          entrypoints: ['encoding-control-entry'],
          packages: 'external',
          target: 'bun',
          plugins: [{
            name: 'encoding-control-entry',
            setup(builder) {
              builder.onResolve({ filter: /^encoding-control-entry$/ }, () => ({
                namespace: 'encoding-control-entry',
                path: 'entry',
              }))
              builder.onLoad({ filter: /.*/, namespace: 'encoding-control-entry' }, () => ({
                loader: 'js',
                contents: `export { encode } from ${JSON.stringify(input)}`,
              }))
            },
          }, tokenizerBlockPlugin],
        })
        expect(build.success).toBe(true)
        expect(build.outputs).toHaveLength(1)
        // Avoid module-cache reuse when the runner repeats a control case.
        const source = `${await build.outputs[0]!.text()}\n// ${crypto.randomUUID()}`
        const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
        const control = await import(moduleUrl) as { encode: (input: string) => unknown }
        expect(() => control.encode('control')).toThrow('tokenizer encoding invoked by direct Chat generation')
        expect(probeGlobal.__tokenizerProbeState).toEqual(expected)
      }
      finally {
        probeGlobal.__tokenizerProbeState = previousState
      }
    })

    test('direct Chat generation does not load or invoke tokenizer encodings', () => {
      const child = Bun.spawnSync([
        process.execPath,
        import.meta.path,
        `--root=${repositoryRoot}`,
      ], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          GHC_TOKENIZER_PROBE_CHILD: '1',
          NO_COLOR: '1',
        },
        stderr: 'pipe',
        stdout: 'pipe',
        timeout: 20_000,
      })

      expect(child.exitCode, child.stderr.toString()).toBe(0)
      const probeLine = child.stdout.toString()
        .split(/\r?\n/)
        .find(line => line.startsWith('TOKENIZER_PROBE '))
      expect(probeLine).toBeDefined()

      const result = JSON.parse(probeLine!.slice('TOKENIZER_PROBE '.length)) as TokenizerProbeResult
      expect(result).toMatchObject({
        encodingLoads: 0,
        encodeCalls: 0,
      })
    })
  })
}

async function runProbe() {
  const rootArgument = process.argv.find(argument => argument.startsWith('--root='))?.slice('--root='.length)
  if (!rootArgument)
    throw new Error('Expected --root=<source checkout>')

  const root = isAbsolute(rootArgument) ? rootArgument : resolve(rootArgument)
  probeGlobal.__tokenizerProbeState = { encodeCalls: 0, encodingLoads: 0 }

  const bundledPath = join(repositoryRoot, `.tmp-tokenizer-probe-${process.pid}-${Date.now()}.mjs`)
  const build = await Bun.build({
    entrypoints: ['tokenizer-probe-entry'],
    format: 'esm',
    packages: 'external',
    plugins: [virtualEntryPlugin(root), tokenizerBlockPlugin],
    root,
    splitting: false,
    target: 'bun',
  })
  if (!build.success || build.outputs.length !== 1) {
    throw new Error(`Failed to build tokenizer probe: ${build.logs.map(log => log.message).join('; ')}`)
  }
  await Bun.write(bundledPath, build.outputs[0]!)

  const bundled = await import(pathToFileURL(bundledPath).href) as ProbeBundle
  const { handleCompletionCore, CopilotClient, HTTPError, TerminalUpstreamRecoveryError, state, getCachedConfig } = bundled

  state.authStore.copilotToken = 'offline-token'
  state.authStore.copilotTokenExpiresAt = Date.now() + 60_000
  state.authStore.copilotTokenLastRefreshAt = Date.now()
  state.authStore.copilotTokenLastRefreshSucceeded = true
  state.authStore.accountType = 'individual'
  state.authStore.manualApprove = false
  state.authStore.rateLimitSeconds = undefined
  state.authStore.rateLimitWait = false
  state.modelCache.setVSCodeVersion('1.99.0')
  state.modelCache.cacheModels({
    object: 'list',
    data: [buildModel('source'), buildModel('target')],
  })
  state.runtimeStore.requests.reset()

  const config = getCachedConfig() as Record<string, unknown>
  config.overloadFallbacks = { source: 'target' }

  const calls: CapturedCall[] = []
  let fallbackSourceCalls = 0
  const originalCreateChatCompletions = CopilotClient.prototype.createChatCompletions

  CopilotClient.prototype.createChatCompletions = (async (payload) => {
    calls.push({
      ...(payload.max_tokens == null ? {} : { maxTokens: payload.max_tokens }),
      model: payload.model,
      ...(payload.stream == null ? {} : { stream: payload.stream }),
      toolCount: payload.tools?.length ?? 0,
    })

    if (payload.model === 'source' && fallbackSourceCalls++ === 0) {
      throw new TerminalUpstreamRecoveryError(
        new HTTPError(529, {
          error: { message: 'source overloaded', type: 'overloaded_error' },
        }),
        { requestId: 'tokenizer-probe-fallback', retryCount: 1, sourceModel: 'source' },
      )
    }

    if (payload.stream) {
      return (async function* () {
        yield {
          data: JSON.stringify({
            id: 'chatcmpl_tokenizer_probe_stream',
            object: 'chat.completion.chunk',
            created: 1,
            model: payload.model,
            choices: [],
            usage: expectedUsage,
          }),
        }
        yield { data: '[DONE]' }
      })()
    }

    return {
      id: 'chatcmpl_tokenizer_probe',
      object: 'chat.completion',
      created: 1,
      model: payload.model,
      choices: [{
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content: 'ok' },
      }],
      usage: expectedUsage,
    }
  }) as typeof originalCreateChatCompletions

  try {
    const nonStreaming = await runChat(handleCompletionCore, {
      model: 'target',
      messages: [{ role: 'user', content: 'Use the tool.' }],
      tools: [weatherTool()],
    }, 'tokenizer-probe-nonstream')
    if (nonStreaming.result.kind !== 'json')
      throw new Error('Expected non-streaming Chat result')
    assertUsage(nonStreaming.result.data)

    const streaming = await runChat(handleCompletionCore, {
      model: 'target',
      messages: [{ role: 'user', content: 'Stream a short answer.' }],
      max_tokens: 37,
      stream: true,
    }, 'tokenizer-probe-stream')
    if (streaming.result.kind !== 'stream')
      throw new Error('Expected streaming Chat result')
    const streamChunks = []
    for await (const chunk of streaming.result.generator)
      streamChunks.push(chunk)
    const usageChunk = streamChunks.find(chunk => chunk.data !== '[DONE]')
    if (!usageChunk)
      throw new Error('Expected streaming usage chunk')
    assertUsage(JSON.parse(usageChunk.data) as unknown)

    const fallback = await runChat(handleCompletionCore, {
      model: 'source',
      messages: [{ role: 'user', content: 'Recover through the configured fallback.' }],
    }, 'tokenizer-probe-fallback')
    if (fallback.result.kind !== 'json')
      throw new Error('Expected fallback Chat result')
    assertUsage(fallback.result.data)

    assertCalls(calls)
    process.stdout.write(`TOKENIZER_PROBE ${JSON.stringify({
      calls,
      ...probeGlobal.__tokenizerProbeState,
    })}\n`)
  }
  finally {
    CopilotClient.prototype.createChatCompletions = originalCreateChatCompletions
    state.runtimeStore.requests.reset()
    await unlink(bundledPath)
  }
}

interface ProbeBundle {
  handleCompletionCore: typeof import('~/routes/chat-completions/handler').handleCompletionCore
  CopilotClient: typeof import('~/clients').CopilotClient
  HTTPError: typeof import('~/lib/error').HTTPError
  TerminalUpstreamRecoveryError: typeof import('~/clients/upstream-queue').TerminalUpstreamRecoveryError
  state: typeof import('~/state')
  getCachedConfig: typeof import('~/lib/config').getCachedConfig
}

function virtualEntryPlugin(root: string): Bun.BunPlugin {
  const source = (relativePath: string) => JSON.stringify(join(root, relativePath).replaceAll('\\', '/'))
  return {
    name: 'tokenizer-probe-entry',
    setup(builder) {
      builder.onResolve({ filter: /^tokenizer-probe-entry$/ }, () => ({
        namespace: 'tokenizer-probe-entry',
        path: 'entry',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'tokenizer-probe-entry' }, () => ({
        loader: 'ts',
        contents: `
          export { handleCompletionCore } from ${source('src/routes/chat-completions/handler.ts')};
          export { CopilotClient } from ${source('src/clients/index.ts')};
          export { HTTPError } from ${source('src/lib/error.ts')};
          export { TerminalUpstreamRecoveryError } from ${source('src/clients/upstream-queue.ts')};
          export { getCachedConfig } from ${source('src/lib/config.ts')};
          import * as state from ${source('src/state/index.ts')};
          export { state };
        `,
      }))
    },
  }
}

function buildModel(id: string): Model {
  return {
    id,
    model_picker_enabled: true,
    name: id,
    object: 'model',
    preview: false,
    vendor: 'openai',
    version: '1',
    capabilities: {
      family: 'gpt',
      limits: {
        max_context_window_tokens: 200_000,
        max_output_tokens: 512,
        max_prompt_tokens: 180_000,
      },
      object: 'model_capabilities',
      supports: {
        tool_calls: true,
        parallel_tool_calls: true,
      },
      tokenizer: 'o200k_base',
      type: 'chat',
    },
  }
}

function weatherTool(): NonNullable<CapiChatCompletionsPayload['tools']>[number] {
  return {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Return current weather for a city.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
        },
        required: ['city'],
      },
    },
  }
}

async function runChat(
  handleCompletionCore: typeof import('~/routes/chat-completions/handler').handleCompletionCore,
  body: Record<string, unknown>,
  requestId: string,
) {
  return await handleCompletionCore({
    body,
    signal: new AbortController().signal,
    headers: new Headers({ 'content-type': 'application/json' }),
    requestId,
  })
}

function assertCalls(captured: CapturedCall[]) {
  const expected = [
    { model: 'target', maxTokens: 512, stream: undefined, toolCount: 1 },
    { model: 'target', maxTokens: 37, stream: true, toolCount: 0 },
    { model: 'source', maxTokens: 512, stream: undefined, toolCount: 0 },
    { model: 'target', maxTokens: 512, stream: undefined, toolCount: 0 },
  ]
  if (
    captured.length !== expected.length
    || captured.some((call, index) => {
      const wanted = expected[index]!
      return call.model !== wanted.model
        || call.maxTokens !== wanted.maxTokens
        || call.stream !== wanted.stream
        || call.toolCount !== wanted.toolCount
    })
  ) {
    throw new Error(`Unexpected upstream calls: ${JSON.stringify(captured)}`)
  }
}

function assertUsage(value: unknown) {
  if (!value || typeof value !== 'object' || !('usage' in value))
    throw new Error(`Missing usage: ${JSON.stringify(value)}`)
  if (JSON.stringify(value.usage) !== JSON.stringify(expectedUsage))
    throw new Error(`Unexpected usage: ${JSON.stringify(value.usage)}`)
}
