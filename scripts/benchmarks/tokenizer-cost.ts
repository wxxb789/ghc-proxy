import type { ChatCompletionsPayload, Model } from '~/types'

import { isAbsolute, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const LINE_SEPARATOR_RE = /\r?\n/

type Layer = 'handler' | 'helper'
type CacheMode = 'cold' | 'uncached' | 'warm'

interface BenchmarkCase {
  bounded?: boolean
  name: string
  pathological?: boolean
  payload: ChatCompletionsPayload
}

interface BenchmarkCaseDefinition {
  bounded?: boolean
  createPayload: () => ChatCompletionsPayload
  name: string
  pathological?: boolean
}

interface Sample {
  cache: CacheMode
  case: string
  cpuSystemMs: number
  cpuUserMs: number
  eventLoopDelayMs: number
  layer: Layer
  maxRssKb: number
  payloadBytes: number
  rssAfterGc: number
  rssBefore: number
  wallMs: number
}

interface WorkerResult {
  samples: Sample[]
}

interface Runtime {
  clearMergeCache: () => Promise<void>
  cleanup: () => void
  invoke: (payload: ChatCompletionsPayload, requestId: string) => Promise<void>
}

export interface SourceIdentity {
  dirty: boolean | null
  fileCount: number
  headSha: string | null
  treeSha256: string
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2))
  if (options.worker) {
    process.stdout.write(`TOKENIZER_BENCH_SAMPLE ${JSON.stringify(await runWorker(options))}\n`)
  }
  else {
    process.stdout.write(`${JSON.stringify(await runCoordinator(options), null, 2)}\n`)
  }
}

function parseOptions(args: string[]) {
  const value = (name: string) => args.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
  const rootValue = value('root')
  if (!rootValue)
    throw new Error('Expected --root=<source checkout>')

  const root = isAbsolute(rootValue) ? rootValue : resolve(rootValue)
  const cold = parsePositiveInteger(value('cold') ?? '10', '--cold')
  const warm = parsePositiveInteger(value('warm') ?? '30', '--warm')
  const iterations = parsePositiveInteger(value('iterations') ?? '1', '--iterations')
  const selectedCases = value('cases')?.split(',').filter(Boolean)
  const selectedLayers = (value('layers')?.split(',').filter(Boolean) ?? ['handler', 'helper']) as Layer[]
  for (const layer of selectedLayers) {
    if (layer !== 'handler' && layer !== 'helper')
      throw new Error(`Unsupported layer: ${layer}`)
  }

  const cache = value('cache') as CacheMode | undefined
  if (cache && cache !== 'cold' && cache !== 'uncached' && cache !== 'warm')
    throw new Error(`Unsupported cache mode: ${cache}`)

  return {
    cache,
    caseName: value('case'),
    cold,
    includePathological: args.includes('--pathological'),
    iterations,
    root,
    selectedCases,
    selectedLayers,
    warm,
    worker: args.includes('--worker'),
  }
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`)
  return parsed
}

async function runCoordinator(options: ReturnType<typeof parseOptions>) {
  const sourceIdentity = await readSourceIdentity(options.root)
  const caseDefinitions = benchmarkCaseDefinitions()
    .filter(testCase => options.includePathological || !testCase.pathological)
    .filter(testCase => !options.selectedCases || options.selectedCases.includes(testCase.name))
  if (caseDefinitions.length === 0)
    throw new Error('No benchmark cases selected')

  const results: Array<WorkerResult & { cache: CacheMode, case: string, layer: Layer } | {
    cache: CacheMode
    case: string
    layer: Layer
    status: 'censored'
    timeoutMs: number
  }> = []

  for (const [caseIndex, definition] of caseDefinitions.entries()) {
    const testCase = materializeCase(definition)
    const layers = caseIndex % 2 === 0
      ? options.selectedLayers
      : [...options.selectedLayers].reverse()
    for (const layer of layers) {
      const coldIterations = testCase.bounded || testCase.pathological ? 1 : options.cold
      for (let index = 0; index < coldIterations; index++) {
        results.push(runSubprocess(options, testCase, layer, 'cold', 1))
      }

      const steadyIterations = testCase.bounded || testCase.pathological ? 1 : options.warm
      results.push(runSubprocess(options, testCase, layer, 'uncached', steadyIterations))
      results.push(runSubprocess(options, testCase, layer, 'warm', steadyIterations))
    }
  }

  const harnessBytes = await Bun.file(import.meta.path).arrayBuffer()
  const harnessSha256 = new Bun.CryptoHasher('sha256').update(harnessBytes).digest('hex')
  return {
    schema: 'ghc-proxy/tokenizer-cost/v1',
    generatedAt: new Date().toISOString(),
    root: options.root,
    sourceHeadSha: sourceIdentity.headSha,
    sourceDirty: sourceIdentity.dirty,
    sourceTreeSha256: sourceIdentity.treeSha256,
    sourceFileCount: sourceIdentity.fileCount,
    harnessSha256,
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    protocol: {
      coldSamples: options.cold,
      warmSamples: options.warm,
      pathologicalTimeoutMs: 20_000,
      note: 'Cold samples include source import/setup in a fresh process; helper and end-to-end handler samples remain separate.',
    },
    results,
  }
}

function runSubprocess(
  options: ReturnType<typeof parseOptions>,
  testCase: BenchmarkCase,
  layer: Layer,
  cache: CacheMode,
  iterations: number,
) {
  const timeoutMs = testCase.bounded || testCase.pathological
    ? 20_000
    : Math.max(20_000, iterations * 10_000)
  const child = Bun.spawnSync([
    process.execPath,
    import.meta.path,
    `--root=${options.root}`,
    '--worker',
    `--case=${testCase.name}`,
    `--layers=${layer}`,
    `--cache=${cache}`,
    `--iterations=${iterations}`,
  ], {
    cwd: options.root,
    env: { ...process.env, NO_COLOR: '1' },
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: timeoutMs,
  })

  if (child.exitCode !== 0) {
    if ((testCase.bounded || testCase.pathological) && child.exitedDueToTimeout) {
      return {
        cache,
        case: testCase.name,
        layer,
        status: 'censored' as const,
        timeoutMs,
      }
    }
    throw new Error(child.stderr.toString() || `Benchmark worker exited ${child.exitCode}`)
  }

  const line = child.stdout.toString().split(LINE_SEPARATOR_RE).find(
    output => output.startsWith('TOKENIZER_BENCH_SAMPLE '),
  )
  if (!line)
    throw new Error(`Benchmark worker produced no result: ${child.stdout.toString()}`)
  return {
    cache,
    case: testCase.name,
    layer,
    ...JSON.parse(line.slice('TOKENIZER_BENCH_SAMPLE '.length)) as WorkerResult,
  }
}

async function runWorker(options: ReturnType<typeof parseOptions>): Promise<WorkerResult> {
  const definition = benchmarkCaseDefinitions().find(candidate => candidate.name === options.caseName)
  const testCase = definition ? materializeCase(definition) : undefined
  const layer = options.selectedLayers[0]
  const cache = options.cache
  if (!testCase || !layer || !cache)
    throw new Error('Worker requires --case, one --layers value, and --cache')
  const payloadBytes = new TextEncoder().encode(JSON.stringify(testCase.payload)).byteLength

  if (cache === 'cold') {
    const sample = await measure(testCase, layer, cache, payloadBytes, async () => {
      const runtime = await createRuntime(options.root, layer)
      try {
        await runtime.invoke(testCase.payload, 'tokenizer-bench-cold')
      }
      finally {
        runtime.cleanup()
      }
    })
    return { samples: [sample] }
  }

  const runtime = await createRuntime(options.root, layer)
  try {
    await runtime.invoke(testCase.payload, 'tokenizer-bench-warmup')
    const samples: Sample[] = []
    for (let index = 0; index < options.iterations; index++) {
      if (cache === 'uncached')
        await runtime.clearMergeCache()
      samples.push(await measure(testCase, layer, cache, payloadBytes, () => runtime.invoke(
        testCase.payload,
        `tokenizer-bench-${cache}-${index}`,
      )))
    }
    return { samples }
  }
  finally {
    runtime.cleanup()
  }
}

async function createRuntime(root: string, layer: Layer): Promise<Runtime> {
  const model = buildModel()
  if (layer === 'helper') {
    const tokenizerModule = await importFromRoot<typeof import('~/lib/tokenizer')>(root, 'src/lib/tokenizer.ts')
    let encodingModule: { clearMergeCache: () => void } | undefined
    return {
      async clearMergeCache() {
        encodingModule ??= await importFromRoot<{ clearMergeCache: () => void }>(
          root,
          'node_modules/gpt-tokenizer/esm/encoding/o200k_base.js',
        )
        encodingModule.clearMergeCache()
      },
      cleanup() {},
      async invoke(payload) {
        await tokenizerModule.getTokenCount(structuredClone(payload), model)
      },
    }
  }

  const [handlerModule, clientsModule, state, consolaModule, handlerSource]
    = await Promise.all([
      importFromRoot<typeof import('~/routes/chat-completions/handler')>(root, 'src/routes/chat-completions/handler.ts'),
      importFromRoot<typeof import('~/clients')>(root, 'src/clients/index.ts'),
      importFromRoot<typeof import('~/state')>(root, 'src/state/index.ts'),
      import('consola'),
      Bun.file(join(root, 'src/routes/chat-completions/handler.ts')).text(),
    ])
  consolaModule.default.level = -999

  const shouldClearMergeCache = handlerSource.includes('from \'~/lib/tokenizer\'')
    && handlerSource.includes('getTokenCount')
  let encodingModule: { clearMergeCache: () => void } | undefined

  state.authStore.copilotToken = 'offline-token'
  state.authStore.copilotTokenExpiresAt = Date.now() + 60_000
  state.authStore.copilotTokenLastRefreshAt = Date.now()
  state.authStore.copilotTokenLastRefreshSucceeded = true
  state.authStore.accountType = 'individual'
  state.authStore.manualApprove = false
  state.authStore.rateLimitSeconds = undefined
  state.authStore.rateLimitWait = false
  state.modelCache.setVSCodeVersion('1.99.0')
  state.modelCache.cacheModels({ object: 'list', data: [model] })

  const original = clientsModule.CopilotClient.prototype.createChatCompletions
  clientsModule.CopilotClient.prototype.createChatCompletions = (async payload => ({
    id: 'chatcmpl_tokenizer_benchmark',
    object: 'chat.completion',
    created: 1,
    model: payload.model,
    choices: [{
      index: 0,
      finish_reason: 'stop',
      logprobs: null,
      message: { role: 'assistant', content: 'ok' },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })) as typeof original

  return {
    async clearMergeCache() {
      if (!shouldClearMergeCache)
        return
      encodingModule ??= await importFromRoot<{ clearMergeCache: () => void }>(
        root,
        'node_modules/gpt-tokenizer/esm/encoding/o200k_base.js',
      )
      encodingModule.clearMergeCache()
    },
    cleanup() {
      clientsModule.CopilotClient.prototype.createChatCompletions = original
      state.runtimeStore.requests.reset()
    },
    async invoke(payload, requestId) {
      await handlerModule.handleCompletionCore({
        body: structuredClone(payload),
        signal: new AbortController().signal,
        headers: new Headers({ 'content-type': 'application/json' }),
        requestId,
      })
    },
  }
}

async function measure(
  testCase: BenchmarkCase,
  layer: Layer,
  cache: CacheMode,
  payloadBytes: number,
  operation: () => Promise<void>,
): Promise<Sample> {
  Bun.gc(true)
  const rssBefore = process.memoryUsage().rss
  const cpuBefore = process.cpuUsage()
  const started = performance.now()
  const timer = new Promise<number>((resolveTimer) => {
    setTimeout(() => resolveTimer(performance.now() - started), 0)
  })
  await operation()
  const wallMs = performance.now() - started
  const cpu = process.cpuUsage(cpuBefore)
  const eventLoopDelayMs = await timer
  Bun.gc(true)

  return {
    cache,
    case: testCase.name,
    cpuSystemMs: cpu.system / 1_000,
    cpuUserMs: cpu.user / 1_000,
    eventLoopDelayMs,
    layer,
    maxRssKb: process.resourceUsage().maxRSS,
    payloadBytes,
    rssAfterGc: process.memoryUsage().rss,
    rssBefore,
    wallMs,
  }
}

async function importFromRoot<T>(root: string, relativePath: string): Promise<T> {
  return await import(pathToFileURL(join(root, relativePath)).href) as T
}

export async function readSourceIdentity(root: string): Promise<SourceIdentity> {
  const relativePaths = new Set<string>()
  const glob = new Bun.Glob('src/**/*')
  for await (const relativePath of glob.scan({ cwd: root, onlyFiles: true }))
    relativePaths.add(relativePath.replaceAll('\\', '/'))

  for (const relativePath of ['package.json', 'bun.lock', 'tsconfig.json', 'tsdown.config.ts']) {
    if (await Bun.file(join(root, relativePath)).exists())
      relativePaths.add(relativePath)
  }

  const entries: Array<[path: string, bytes: number, sha256: string]> = []
  for (const relativePath of [...relativePaths].sort()) {
    const bytes = await Bun.file(join(root, relativePath)).arrayBuffer()
    const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    entries.push([relativePath, bytes.byteLength, sha256])
  }

  const gitHead = Bun.spawnSync(['git', '-C', root, 'rev-parse', 'HEAD'], {
    stderr: 'ignore',
    stdout: 'pipe',
  })
  const headSha = gitHead.exitCode === 0 ? gitHead.stdout.toString().trim() : null
  const gitStatus = headSha === null
    ? null
    : Bun.spawnSync(['git', '-C', root, 'status', '--porcelain', '--untracked-files=all'], {
        stderr: 'ignore',
        stdout: 'pipe',
      })

  return {
    dirty: gitStatus === null || gitStatus.exitCode !== 0
      ? null
      : gitStatus.stdout.byteLength > 0,
    fileCount: entries.length,
    headSha,
    treeSha256: new Bun.CryptoHasher('sha256').update(JSON.stringify(entries)).digest('hex'),
  }
}

function buildModel(): Model {
  return {
    id: 'gpt-benchmark',
    model_picker_enabled: true,
    name: 'gpt-benchmark',
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
      supports: { tool_calls: true, parallel_tool_calls: true },
      tokenizer: 'o200k_base',
      type: 'chat',
    },
  }
}

function benchmarkCaseDefinitions(): BenchmarkCaseDefinition[] {
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  return [
    chatDefinition('english', () => 'Summarize the tradeoffs between throughput, latency, and memory for a local API proxy.'),
    chatDefinition('cjk', () => '请分析这个反向代理的延迟、吞吐量和内存占用，并给出简洁结论。'),
    chatDefinition('code', () => 'Review this TypeScript:\n```ts\nexport async function map<T>(items: T[]) { return Promise.all(items.map(async item => item)) }\n```'),
    chatDefinition('json', () => JSON.stringify({ request: 'benchmark', flags: [true, false], nested: { count: 42, values: ['a', 'b', 'c'] } })),
    {
      name: 'tools',
      createPayload: () => ({
        model: 'gpt-benchmark',
        messages: [{ role: 'user', content: 'Use the best matching tool.' }],
        tools: Array.from({ length: 12 }, (_, index) => ({
          type: 'function' as const,
          function: {
            name: `lookup_${index}`,
            description: `Look up deterministic dataset ${index}.`,
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' }, limit: { type: 'integer' } },
              required: ['query'],
            },
          },
        })),
      }),
    },
    {
      name: 'image',
      createPayload: () => ({
        model: 'gpt-benchmark',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this valid one-pixel PNG.' },
            { type: 'image_url', image_url: { url: image } },
          ],
        }],
      }),
    },
    chatDefinition('repeated-100k', () => 'abcd'.repeat(25_000), { bounded: true }),
    chatDefinition('pathological-1m', () => 'a'.repeat(1_000_000), { pathological: true }),
  ]
}

function chatDefinition(
  name: string,
  content: () => string,
  flags: Pick<BenchmarkCaseDefinition, 'bounded' | 'pathological'> = {},
): BenchmarkCaseDefinition {
  return {
    ...flags,
    name,
    createPayload: () => ({
      model: 'gpt-benchmark',
      messages: [{ role: 'user', content: content() }],
    }),
  }
}

function materializeCase(definition: BenchmarkCaseDefinition): BenchmarkCase {
  return {
    bounded: definition.bounded,
    name: definition.name,
    pathological: definition.pathological,
    payload: definition.createPayload(),
  }
}
