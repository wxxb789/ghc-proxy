/**
 * Smoke-test script for ghc-proxy Anthropic↔OpenAI translation.
 *
 * Covers: non-thinking, thinking, streaming, and offline translation preview.
 * This is a manual dev-time sanity check — it is not part of the test suite.
 *
 * Usage:
 *   bun run scripts/smoke-test.ts            # offline preview + live proxy tests
 *   bun run scripts/smoke-test.ts --offline   # offline preview only (no proxy needed)
 *
 * Prerequisites (live mode):
 *   The proxy must be running on port 4142:
 *     bun run dev start --port 4142 --verbose --wait
 */

import process from 'node:process'
import { events } from 'fetch-event-stream'

const BASE_URL = 'http://localhost:4142'
const ENDPOINT = `${BASE_URL}/v1/messages`

const PROXY_HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': 'dummy',
  'anthropic-version': '2023-06-01',
} as const

const MAX_REASONING_DISPLAY_CHARS = 4000

// ---------- payloads ----------

const basePayload = {
  model: 'claude-sonnet-4.6',
  max_tokens: 128000,
  stream: false,
  temperature: 0.7,
  messages: [
    {
      role: 'user',
      content: 'Calculate: 123*777*888*123*321 \nThink step by step.',
    },
  ],
}

const payloadThinking = {
  ...basePayload,
  thinking: { type: 'enabled', budget_tokens: 48000 },
}

const payloadThinkingStream = {
  ...basePayload,
  stream: true,
  thinking: { type: 'enabled', budget_tokens: 48000 },
}

// ---------- helpers ----------

function section(title: string) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${title}`)
  console.log('='.repeat(60))
}

async function postToProxy(payload: object): Promise<Response> {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: PROXY_HEADERS,
    body: JSON.stringify(payload),
  })
}

function handleFetchError(err: unknown) {
  console.error(`\n[ERROR] Could not reach proxy at ${ENDPOINT}`)
  console.error(`  Make sure ghc-proxy is running:  bun run dev start --port 4142 --verbose --wait`)
  console.error(`  Error: ${err}`)
}

async function sendRequest(label: string, payload: object) {
  section(label)

  try {
    const res = await postToProxy(payload)
    console.log(`\n--- HTTP ${res.status} ${res.statusText} ---`)

    const body = await res.text()
    try {
      const json = JSON.parse(body)
      console.log('\n--- Anthropic response (translated back from OpenAI) ---')
      console.log(JSON.stringify(json, null, 2))
    }
    catch {
      console.log('\n--- Raw response body ---')
      console.log(body.slice(0, 2000))
    }
  }
  catch (err) {
    handleFetchError(err)
  }
}

async function sendStreamingRequest(label: string, payload: object) {
  section(label)

  try {
    const res = await postToProxy(payload)
    console.log(`\n--- HTTP ${res.status} ${res.statusText} ---`)

    if (!res.body) {
      console.log('[WARN] Response has no body (readable stream)')
      return
    }

    console.log('\n--- SSE stream events ---')

    let eventCount = 0
    const contentParts: string[] = []
    const reasoningParts: string[] = []
    let reasoningTotalChars = 0
    let loggedFirstThinking = false
    let loggedFirstText = false

    for await (const event of events(res)) {
      const data = event.data?.trim()
      if (!data)
        continue

      if (data === '[DONE]') {
        console.log(`  [event ${++eventCount}] [DONE]`)
        continue
      }

      try {
        const parsed = JSON.parse(data)
        eventCount++

        switch (parsed.type) {
          case 'content_block_delta': {
            const deltaType = parsed.delta?.type
            if (deltaType === 'thinking_delta') {
              const text = parsed.delta.thinking ?? ''
              reasoningParts.push(text)
              reasoningTotalChars += text.length
              if (!loggedFirstThinking) {
                console.log(`  [event ${eventCount}] first thinking_delta (sample): ${text.slice(0, 120)}...`)
                loggedFirstThinking = true
              }
            }
            else if (deltaType === 'text_delta') {
              contentParts.push(parsed.delta.text ?? '')
              if (!loggedFirstText) {
                console.log(`  [event ${eventCount}] first text_delta (sample): ${(parsed.delta.text ?? '').slice(0, 120)}...`)
                loggedFirstText = true
              }
            }
            break
          }

          case 'message_start':
          case 'content_block_start':
          case 'content_block_stop':
          case 'message_delta':
          case 'message_stop':
            console.log(`  [event ${eventCount}] ${parsed.type}`)
            break

          default:
            console.log(`  [event ${eventCount}] unknown type "${parsed.type}"`)
            break
        }
      }
      catch {
        console.log(`  [event ${++eventCount}] (unparseable) ${data.slice(0, 200)}`)
      }
    }

    // Summary
    console.log(`\n--- Stream summary ---`)
    console.log(`  Total SSE events: ${eventCount}`)
    console.log(`  Content chunks: ${contentParts.length}`)
    console.log(`  Reasoning chunks: ${reasoningParts.length} (${reasoningTotalChars} chars total)`)

    if (reasoningParts.length > 0) {
      const full = reasoningParts.join('')
      console.log(`\n--- Reasoning (first ${MAX_REASONING_DISPLAY_CHARS} of ${full.length} chars) ---`)
      console.log(full.slice(0, MAX_REASONING_DISPLAY_CHARS))
    }

    if (contentParts.length > 0) {
      const full = contentParts.join('')
      console.log(`\n--- Content (first 2000 chars) ---`)
      console.log(full.slice(0, 2000))
    }

    if (contentParts.length === 0 && reasoningParts.length === 0) {
      console.log(`\n[WARN] No content or reasoning chunks received in stream`)
    }
  }
  catch (err) {
    handleFetchError(err)
  }
}

function printTranslationPreview() {
  section('OFFLINE TRANSLATION PREVIEW (no proxy needed)')

  // eslint-disable-next-line ts/no-require-imports
  const { AnthropicTranslator } = require('../src/translator') as typeof import('../src/translator')
  const translator = new AnthropicTranslator()

  const cases = [
    { label: 'No thinking', payload: basePayload },
    { label: 'Thinking (48k budget)', payload: payloadThinking },
  ] as const

  for (const { label, payload } of cases) {
    const translated = translator.toOpenAI(payload as any)

    console.log(`\n${'─'.repeat(50)}`)
    console.log(`  ${label}`)
    console.log('─'.repeat(50))

    console.log('\nAnthropic input:')
    console.log(JSON.stringify(payload, null, 2))

    console.log('\nOpenAI output (translated):')
    console.log(JSON.stringify(translated, null, 2))
  }
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2)
  const offlineOnly = args.includes('--offline')

  printTranslationPreview()

  if (offlineOnly) {
    console.log('\n(--offline mode: skipping live proxy requests)\n')
    return
  }

  section('LIVE PROXY REQUESTS (port 4142)')

  await sendRequest('1) No thinking (baseline)', basePayload)
  await sendRequest('2) Thinking, non-streaming', payloadThinking)
  await sendStreamingRequest('3) Thinking, streaming', payloadThinkingStream)
}

main().catch(console.error)
