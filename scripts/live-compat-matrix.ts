#!/usr/bin/env bun

import type { Model, ResponsesResult } from '~/types'

import process from 'node:process'
import consola from 'consola'
import { readConfig } from '~/lib/config'
import { ensurePaths } from '~/lib/paths'
import { cacheModels, cacheVSCodeVersion, state } from '~/lib/state'
import { setupCopilotToken, setupGitHubToken } from '~/lib/token'
import { server } from '~/server'

type MatrixStatus
  = | 'supported'
    | 'proxy_rejected'
    | 'proxy_error'
    | 'upstream_rejected'
    | 'transport_error'
    | 'skipped'

interface MatrixResult {
  area: 'responses' | 'messages'
  case: string
  model?: string
  status: MatrixStatus
  httpStatus?: number
  note: string
}

interface RequestCase {
  area: MatrixResult['area']
  name: string
  buildRequest?: (model: Model) => {
    path: string
    method?: 'GET' | 'POST' | 'DELETE'
    body: Record<string, unknown>
    expectStream?: boolean
  }
  run?: (model: Model) => Promise<MatrixResult>
}

const rawArgs = Bun.argv.slice(2)
const args = new Set(rawArgs)
const jsonMode = args.has('--json')
const visionOnly = args.has('--vision-only')
const statefulOnly = args.has('--stateful-only')
const allResponsesModels = args.has('--all-responses-models')
const requestedModelId = rawArgs.find(arg => arg.startsWith('--model='))?.slice('--model='.length)
const REQUEST_TIMEOUT_MS = 120_000

const tinyPngDataUrl = [
  'data:image/png;base64,',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
].join('')

const responsesCases: Array<RequestCase> = [
  {
    area: 'responses',
    name: 'text_non_stream',
    buildRequest: model => ({
      path: '/v1/responses',
      body: {
        model: model.id,
        input: [{ type: 'message', role: 'user', content: 'Reply with the single word OK.' }],
        max_output_tokens: 64,
      },
    }),
  },
  {
    area: 'responses',
    name: 'text_stream',
    buildRequest: model => ({
      path: '/v1/responses',
      body: {
        model: model.id,
        input: [{ type: 'message', role: 'user', content: 'Reply with the single word OK.' }],
        max_output_tokens: 64,
        stream: true,
      },
      expectStream: true,
    }),
  },
  {
    area: 'responses',
    name: 'function_tool_forced',
    buildRequest: model => ({
      path: '/v1/responses',
      body: {
        model: model.id,
        input: [{ type: 'message', role: 'user', content: 'Call the echo tool with {"value":"ok"}.' }],
        tools: [{
          type: 'function',
          name: 'echo',
          description: 'Echo a payload back to the caller.',
          parameters: {
            type: 'object',
            properties: {
              value: { type: 'string' },
            },
            required: ['value'],
          },
          strict: false,
        }],
        tool_choice: {
          type: 'function',
          name: 'echo',
        },
        max_output_tokens: 128,
      },
    }),
  },
  {
    area: 'responses',
    name: 'apply_patch_shim',
    buildRequest: model => ({
      path: '/v1/responses',
      body: {
        model: model.id,
        input: [{ type: 'message', role: 'user', content: 'Call apply_patch with a no-op patch.' }],
        tools: [{
          type: 'custom',
          name: 'apply_patch',
        }],
        tool_choice: {
          type: 'function',
          name: 'apply_patch',
        },
        max_output_tokens: 128,
      },
    }),
  },
  {
    area: 'responses',
    name: 'vision_data_url',
    buildRequest: model => ({
      path: '/v1/responses',
      body: {
        model: model.id,
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Reply with the word image.' },
            { type: 'input_image', image_url: tinyPngDataUrl, detail: 'low' },
          ],
        }],
        max_output_tokens: 64,
      },
    }),
  },
  {
    area: 'responses',
    name: 'vision_remote_url',
    buildRequest: model => ({
      path: '/v1/responses',
      body: {
        model: model.id,
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Reply with the word image.' },
            { type: 'input_image', image_url: 'https://httpbin.org/image/png', detail: 'low' },
          ],
        }],
        max_output_tokens: 64,
      },
    }),
  },
  {
    area: 'responses',
    name: 'reasoning_low',
    buildRequest: model => ({
      path: '/v1/responses',
      body: {
        model: model.id,
        input: [{ type: 'message', role: 'user', content: 'Reply with the single word reasoned.' }],
        reasoning: {
          effort: 'low',
          summary: 'detailed',
        },
        include: ['reasoning.encrypted_content'],
        max_output_tokens: 64,
      },
    }),
  },
  {
    area: 'responses',
    name: 'web_search_rejected',
    buildRequest: model => ({
      path: '/v1/responses',
      body: {
        model: model.id,
        input: [{ type: 'message', role: 'user', content: 'Search the web for today news.' }],
        tools: [{
          type: 'web_search',
          name: 'web_search_preview',
        }],
        max_output_tokens: 64,
      },
    }),
  },
  {
    area: 'responses',
    name: 'previous_response_id_followup',
    run: async (model) => {
      const initial = await dispatchRequest({
        path: '/v1/responses',
        method: 'POST',
        body: {
          model: model.id,
          input: [{ type: 'message', role: 'user', content: 'Reply with the single word FIRST.' }],
          max_output_tokens: 32,
        },
      })
      if (initial.response.status < 200 || initial.response.status >= 300) {
        return classifyJsonResult({
          area: 'responses',
          name: 'previous_response_id_followup',
        }, model, initial.response.status, initial.payload)
      }

      const responseId = getResponseId(initial.payload)
      if (!responseId) {
        return {
          area: 'responses',
          case: 'previous_response_id_followup',
          model: model.id,
          status: 'transport_error',
          httpStatus: initial.response.status,
          note: 'Initial response did not include an id.',
        }
      }

      const followup = await dispatchRequest({
        path: '/v1/responses',
        method: 'POST',
        body: {
          model: model.id,
          previous_response_id: responseId,
          input: [{ type: 'message', role: 'user', content: 'Reply with the single word SECOND.' }],
          max_output_tokens: 32,
        },
      })

      return classifyJsonResult({
        area: 'responses',
        name: 'previous_response_id_followup',
      }, model, followup.response.status, followup.payload)
    },
  },
  {
    area: 'responses',
    name: 'text_format_text',
    buildRequest: model => ({
      path: '/v1/responses',
      body: {
        model: model.id,
        input: [{ type: 'message', role: 'user', content: 'Reply with the single word TEXT.' }],
        text: {
          format: {
            type: 'text',
          },
        },
        max_output_tokens: 32,
      },
    }),
  },
  {
    area: 'responses',
    name: 'input_file_data_text',
    buildRequest: model => ({
      path: '/v1/responses',
      body: {
        model: model.id,
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Read the attached file and reply with the single word FILE.' },
            {
              type: 'input_file',
              filename: 'note.txt',
              file_data: 'data:text/plain;base64,SGVsbG8sIGZpbGUh',
            },
          ],
        }],
        max_output_tokens: 64,
      },
    }),
  },
  {
    area: 'responses',
    name: 'input_tokens',
    run: async (model) => {
      const counted = await dispatchRequest({
        path: '/v1/responses/input_tokens',
        method: 'POST',
        body: {
          model: model.id,
          input: [{ type: 'message', role: 'user', content: 'Reply with the single word STORED.' }],
        },
      })
      if (counted.response.status < 200 || counted.response.status >= 300) {
        return classifyJsonResult({
          area: 'responses',
          name: 'input_tokens',
        }, model, counted.response.status, counted.payload)
      }

      return classifyJsonResult({
        area: 'responses',
        name: 'input_tokens',
      }, model, counted.response.status, counted.payload)
    },
  },
  {
    area: 'responses',
    name: 'resource_retrieve_input_items_delete',
    run: async (model) => {
      const created = await dispatchRequest({
        path: '/v1/responses',
        method: 'POST',
        body: {
          model: model.id,
          input: [{ type: 'message', role: 'user', content: 'Reply with the single word STORED.' }],
          max_output_tokens: 32,
        },
      })
      if (created.response.status < 200 || created.response.status >= 300) {
        return classifyJsonResult({
          area: 'responses',
          name: 'resource_retrieve_input_items_delete',
        }, model, created.response.status, created.payload)
      }

      const responseId = getResponseId(created.payload)
      if (!responseId) {
        return {
          area: 'responses',
          case: 'resource_retrieve_input_items_delete',
          model: model.id,
          status: 'transport_error',
          httpStatus: created.response.status,
          note: 'Created response did not include an id.',
        }
      }

      const encodedId = encodeURIComponent(responseId)
      const retrieve = await dispatchRequest({
        path: `/v1/responses/${encodedId}`,
        method: 'GET',
        body: {},
      })
      if (retrieve.response.status < 200 || retrieve.response.status >= 300) {
        return classifyJsonResult({
          area: 'responses',
          name: 'resource_retrieve_input_items_delete',
        }, model, retrieve.response.status, retrieve.payload)
      }

      const inputItems = await dispatchRequest({
        path: `/v1/responses/${encodedId}/input_items?limit=1`,
        method: 'GET',
        body: {},
      })
      if (inputItems.response.status < 200 || inputItems.response.status >= 300) {
        return classifyJsonResult({
          area: 'responses',
          name: 'resource_retrieve_input_items_delete',
        }, model, inputItems.response.status, inputItems.payload)
      }

      const deleted = await dispatchRequest({
        path: `/v1/responses/${encodedId}`,
        method: 'DELETE',
        body: {},
      })
      return classifyJsonResult({
        area: 'responses',
        name: 'resource_retrieve_input_items_delete',
      }, model, deleted.response.status, deleted.payload)
    },
  },
]

const messageCases: Array<RequestCase> = [
  {
    area: 'messages',
    name: 'native_messages_non_stream',
    buildRequest: model => ({
      path: '/v1/messages',
      body: {
        model: model.id,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Reply with the single word native.' }],
      },
    }),
  },
  {
    area: 'messages',
    name: 'native_messages_stream',
    buildRequest: model => ({
      path: '/v1/messages',
      body: {
        model: model.id,
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'Reply with the single word native.' }],
      },
      expectStream: true,
    }),
  },
]

const responsesTranslationMessageCases: Array<RequestCase> = [
  {
    area: 'messages',
    name: 'responses_translation_non_stream',
    buildRequest: model => ({
      path: '/v1/messages',
      body: {
        model: model.id,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Reply with the single word translated.' }],
      },
    }),
  },
  {
    area: 'messages',
    name: 'responses_translation_stream',
    buildRequest: model => ({
      path: '/v1/messages',
      body: {
        model: model.id,
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'Reply with the single word translated.' }],
      },
      expectStream: true,
    }),
  },
]

async function main() {
  await bootstrap()

  const models = state.cache.models?.data ?? []
  const selectedResponsesModels = resolveResponsesModels(models)
  const selectedResponsesTranslationModel = pickResponsesTranslationModel(models)
  const selectedMessagesModel = pickMessagesModel(models)
  const selectedChatFallbackModel = pickChatFallbackModel(models)
  const activeResponsesCases = resolveResponsesCases()

  const results: Array<MatrixResult> = []

  if (selectedResponsesModels.length > 0) {
    for (const model of selectedResponsesModels) {
      for (const entry of activeResponsesCases) {
        results.push(await runCase(entry, model))
      }
    }
  }
  else {
    results.push({
      area: 'responses',
      case: 'responses_model_selection',
      status: 'skipped',
      note: 'No model with /responses support was available.',
    })
  }

  if (!visionOnly && !statefulOnly && selectedResponsesTranslationModel) {
    for (const entry of responsesTranslationMessageCases) {
      results.push(await runCase(entry, selectedResponsesTranslationModel))
    }
  }
  else if (!visionOnly && !statefulOnly) {
    results.push({
      area: 'messages',
      case: 'responses_translation_model_selection',
      status: 'skipped',
      note: 'No model with /responses-only support was available for Anthropic translation.',
    })
  }

  if (!visionOnly && !statefulOnly && selectedMessagesModel) {
    for (const entry of messageCases) {
      results.push(await runCase(entry, selectedMessagesModel))
    }
  }
  else if (!visionOnly && !statefulOnly) {
    results.push({
      area: 'messages',
      case: 'messages_model_selection',
      status: 'skipped',
      note: 'No model with native /v1/messages support was available.',
    })
  }

  if (!visionOnly && !statefulOnly && selectedChatFallbackModel) {
    results.push(await runChatFallbackCase(selectedChatFallbackModel))
  }
  else if (!visionOnly && !statefulOnly) {
    results.push({
      area: 'messages',
      case: 'chat_fallback_model_selection',
      status: 'skipped',
      note: 'No chat-fallback-only model was available.',
    })
  }

  if (jsonMode) {
    await Bun.write(Bun.stdout, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      selectedModels: {
        responses: selectedResponsesModels.map(model => model.id),
        responsesTranslation: selectedResponsesTranslationModel?.id ?? null,
        nativeMessages: selectedMessagesModel?.id ?? null,
        chatFallback: selectedChatFallbackModel?.id ?? null,
      },
      results,
    }, null, 2)}\n`)
    return
  }

  printHumanSummary({
    responses: selectedResponsesModels.map(model => model.id),
    responsesTranslation: selectedResponsesTranslationModel?.id,
    nativeMessages: selectedMessagesModel?.id,
    chatFallback: selectedChatFallbackModel?.id,
  }, results)
}

async function bootstrap() {
  if (jsonMode) {
    silenceConsola()
  }
  else {
    consola.level = 0
  }
  state.config.accountType = 'enterprise'
  state.config.manualApprove = false
  state.config.rateLimitWait = false
  state.config.showToken = false
  state.config.upstreamTimeoutSeconds = Math.floor(REQUEST_TIMEOUT_MS / 1000)

  await ensurePaths()
  await readConfig()
  await cacheVSCodeVersion()
  await setupGitHubToken()
  await setupCopilotToken()
  await cacheModels()
}

function silenceConsola() {
  const noop = Object.assign(() => {}, { raw: () => {} }) as typeof consola.info
  consola.level = Number.NEGATIVE_INFINITY
  consola.log = noop
  consola.info = noop
  consola.success = noop
  consola.warn = noop
  consola.error = noop
  consola.box = noop
  consola.debug = noop
}

async function runCase(
  entry: RequestCase,
  model: Model,
): Promise<MatrixResult> {
  if (entry.run) {
    return entry.run(model)
  }

  const request = entry.buildRequest?.(model)
  if (!request) {
    return {
      area: entry.area,
      case: entry.name,
      model: model.id,
      status: 'skipped',
      note: 'No request builder defined for this case.',
    }
  }
  if (!jsonMode) {
    process.stdout.write(`Running ${entry.area}.${entry.name} (${model.id})\n`)
  }

  try {
    const { response, payload: parsed } = await dispatchRequest(request)

    if (request.expectStream) {
      const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
      return classifyStreamResult(entry, model, response.status, text)
    }

    return classifyJsonResult(entry, model, response.status, parsed)
  }
  catch (error) {
    return {
      area: entry.area,
      case: entry.name,
      model: model.id,
      status: 'transport_error',
      note: error instanceof Error ? error.message : 'Unknown transport error',
    }
  }
}

async function runChatFallbackCase(model: Model): Promise<MatrixResult> {
  if (!jsonMode) {
    process.stdout.write(`Running messages.chat_fallback_non_stream (${model.id})\n`)
  }

  try {
    const { response, payload: parsed } = await dispatchRequest({
      path: '/v1/messages',
      method: 'POST',
      body: {
        model: model.id,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Reply with the single word fallback.' }],
      },
    })
    return classifyJsonResult({
      area: 'messages',
      name: 'chat_fallback_non_stream',
      buildRequest: () => ({
        path: '/v1/messages',
        body: {},
      }),
    }, model, response.status, parsed)
  }
  catch (error) {
    return {
      area: 'messages',
      case: 'chat_fallback_non_stream',
      model: model.id,
      status: 'transport_error',
      note: error instanceof Error ? error.message : 'Unknown transport error',
    }
  }
}

function classifyStreamResult(
  entry: RequestCase,
  model: Model,
  httpStatus: number,
  body: string,
): MatrixResult {
  if (httpStatus >= 200 && httpStatus < 300) {
    const completed = body.includes('response.completed')
      || body.includes('"type":"message_stop"')
      || body.includes('event: message_stop')
    return {
      area: entry.area,
      case: entry.name,
      model: model.id,
      status: completed ? 'supported' : 'upstream_rejected',
      httpStatus,
      note: completed ? 'Streaming completed successfully.' : summarizeText(body),
    }
  }

  return {
    area: entry.area,
    case: entry.name,
    model: model.id,
    status: inferFailureStatus(httpStatus, body),
    httpStatus,
    note: summarizeText(body),
  }
}

function classifyJsonResult(
  entry: RequestCase,
  model: Model,
  httpStatus: number,
  payload: unknown,
): MatrixResult {
  if (httpStatus >= 200 && httpStatus < 300) {
    return {
      area: entry.area,
      case: entry.name,
      model: model.id,
      status: 'supported',
      httpStatus,
      note: summarizeSuccessPayload(payload),
    }
  }

  return {
    area: entry.area,
    case: entry.name,
    model: model.id,
    status: inferFailureStatus(httpStatus, payload),
    httpStatus,
    note: summarizeFailurePayload(payload),
  }
}

function inferFailureStatus(
  httpStatus: number,
  payload: unknown,
): MatrixStatus {
  const text = typeof payload === 'string'
    ? payload
    : JSON.stringify(payload)

  if (
    httpStatus === 400
    && (text.includes('unsupported_tool_') || text.includes('unsupported_input_'))
  ) {
    return 'proxy_rejected'
  }

  if (httpStatus >= 500 && (text.includes('JSON Parse error') || text.includes('"type":"error"'))) {
    return 'proxy_error'
  }

  if (httpStatus >= 400 && httpStatus < 600) {
    return 'upstream_rejected'
  }

  return 'transport_error'
}

function summarizeSuccessPayload(payload: unknown): string {
  if (isResponsesResult(payload)) {
    const outputTypes = payload.output.map(item => item.type).join(', ') || 'none'
    return `status=${payload.status}; output=${outputTypes}`
  }

  if (isAnthropicResponse(payload)) {
    const contentTypes = payload.content.map((item: { type?: unknown }) => String(item.type ?? 'unknown')).join(', ') || 'none'
    return `stop_reason=${payload.stop_reason}; content=${contentTypes}`
  }

  return summarizeFailurePayload(payload)
}

function summarizeFailurePayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return summarizeText(payload)
  }

  if (payload && typeof payload === 'object') {
    const message = (payload as { error?: { message?: unknown } }).error?.message
    if (typeof message === 'string') {
      return summarizeText(message)
    }
  }

  return summarizeText(JSON.stringify(payload))
}

async function dispatchRequest(request: {
  path: string
  method?: 'GET' | 'POST' | 'DELETE'
  body: Record<string, unknown>
}): Promise<{ response: Response, payload: unknown }> {
  const method = request.method ?? 'POST'
  const body = method === 'POST'
    ? JSON.stringify(request.body)
    : undefined

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await server.handle(new Request(`http://matrix.local${request.path}`, {
      method,
      headers: {
        'content-type': 'application/json',
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }))

    const payload = await safeJson(response)
    if (response.status < 500 || attempt > 0) {
      return { response, payload }
    }

    await Bun.sleep(250)
  }

  throw new Error('Unreachable dispatch request state')
}

function summarizeText(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim().slice(0, 240)
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) {
    return null
  }

  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

function pickResponsesModel(models: Array<Model>): Model | undefined {
  return models.find(model => model.supported_endpoints?.includes('/responses'))
}

function resolveResponsesModels(models: Array<Model>): Array<Model> {
  const responsesModels = models.filter(model => model.supported_endpoints?.includes('/responses'))
  if (requestedModelId) {
    return responsesModels.filter(model => model.id === requestedModelId)
  }
  if (allResponsesModels) {
    return responsesModels
  }

  const selected = pickResponsesModel(models)
  return selected ? [selected] : []
}

function resolveResponsesCases(): Array<RequestCase> {
  if (visionOnly) {
    return responsesCases.filter(entry => entry.name.startsWith('vision_'))
  }
  if (statefulOnly) {
    return responsesCases.filter((entry) => {
      return entry.name === 'previous_response_id_followup'
        || entry.name === 'input_tokens'
        || entry.name === 'resource_retrieve_input_items_delete'
        || entry.name === 'input_file_data_text'
        || entry.name === 'text_format_text'
    })
  }
  return responsesCases
}

function pickMessagesModel(models: Array<Model>): Model | undefined {
  return models.find(model => model.supported_endpoints?.includes('/v1/messages'))
}

function pickResponsesTranslationModel(models: Array<Model>): Model | undefined {
  return models.find((model) => {
    const endpoints = new Set(model.supported_endpoints ?? [])
    return endpoints.has('/responses') && !endpoints.has('/v1/messages')
  })
}

function pickChatFallbackModel(models: Array<Model>): Model | undefined {
  return models.find((model) => {
    const endpoints = new Set(model.supported_endpoints ?? [])
    return !endpoints.has('/responses') && !endpoints.has('/v1/messages')
  })
}

function printHumanSummary(
  selectedModels: {
    responses: Array<string>
    responsesTranslation?: string
    nativeMessages?: string
    chatFallback?: string
  },
  results: Array<MatrixResult>,
) {
  process.stdout.write(`Selected models\n`)
  process.stdout.write(`- responses: ${selectedModels.responses.length > 0 ? selectedModels.responses.join(', ') : 'n/a'}\n`)
  process.stdout.write(`- responses translation: ${selectedModels.responsesTranslation ?? 'n/a'}\n`)
  process.stdout.write(`- native messages: ${selectedModels.nativeMessages ?? 'n/a'}\n`)
  process.stdout.write(`- chat fallback: ${selectedModels.chatFallback ?? 'n/a'}\n\n`)

  for (const result of results) {
    const modelLabel = result.model ? ` (${result.model})` : ''
    process.stdout.write(
      `[${result.status}] ${result.area}.${result.case}${modelLabel}: ${result.note}\n`,
    )
  }
}

function isResponsesResult(value: unknown): value is ResponsesResult {
  return typeof value === 'object'
    && value !== null
    && (value as { object?: unknown }).object === 'response'
    && Array.isArray((value as { output?: unknown }).output)
}

function isAnthropicResponse(
  value: unknown,
): value is {
  stop_reason: string | null
  content: Array<{ type?: unknown }>
} {
  return typeof value === 'object'
    && value !== null
    && Array.isArray((value as { content?: unknown }).content)
    && 'stop_reason' in value
}

function getResponseId(payload: unknown): string | undefined {
  return typeof payload === 'object'
    && payload !== null
    && typeof (payload as { id?: unknown }).id === 'string'
    ? (payload as { id: string }).id
    : undefined
}

void main()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exit(1)
  })
