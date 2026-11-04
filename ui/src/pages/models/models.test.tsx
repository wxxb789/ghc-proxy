import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeFetch, modelFixture, modelsFixture } from '../../test/fixtures'
import { renderDashboard } from '../../test/render'
import { ModelsPage } from './index'

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (originalExecCommand)
    Object.defineProperty(document, 'execCommand', originalExecCommand)
  else
    Reflect.deleteProperty(document, 'execCommand')
})

const alpha = modelFixture({ id: 'alpha', name: 'Alpha\tModel\nPreview', vendor: 'OpenAI', version: 'v1\r2', preview: true })
const beta = modelFixture({ id: 'beta', name: 'Beta', vendor: 'Anthropic' })
const gamma = modelFixture({ id: 'gamma', name: 'Gamma', vendor: 'OpenAI' })

function mountModels() {
  const api = createFakeFetch()
  api.on('GET', '/dashboard/api/models', () => Response.json(modelsFixture({ hostTarget: 'host-account', apiBaseUrl: 'http://backend.localhost:4187/v1', models: [gamma, beta, alpha] })))
  return renderDashboard({ api, url: '/dashboard/models?target=unrelated', children: <ModelsPage /> })
}

describe('models catalog', () => {
  it('groups vendors, sorts within groups and retains selections across filtering and sorting', async () => {
    const { api } = mountModels()
    await settle()
    expect(screen.getByText('Host target: host-account')).toBeVisible()
    const table = screen.getByRole('table', { name: 'Available models' })
    expect(within(table).getAllByRole('rowheader').map(heading => heading.textContent)).toEqual(['Anthropic', 'OpenAI'])
    expect(within(table).getAllByRole('row').map(row => row.textContent).join('|')).toMatch(/Anthropic.*beta.*OpenAI.*alpha.*gamma/s)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select alpha' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter models' }), { target: { value: 'Beta' } })
    expect(screen.queryByRole('checkbox', { name: 'Select alpha' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy selected (1)' })).toBeEnabled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select beta' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter models' }), { target: { value: '' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort models' }), { target: { value: 'desc' } })
    expect(screen.getByRole('checkbox', { name: 'Select alpha' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Select beta' })).toBeChecked()
    fireEvent.keyDown(within(table).getByRole('row', { name: /gamma/ }), { key: 'Enter' })
    expect(screen.getByRole('checkbox', { name: 'Select gamma' })).toBeChecked()
    fireEvent.keyDown(within(table).getByRole('row', { name: /gamma/ }), { key: ' ' })
    expect(screen.getByRole('checkbox', { name: 'Select gamma' })).not.toBeChecked()
    expect(within(table).getAllByRole('row').map(row => row.textContent).join('|')).toMatch(/Anthropic.*beta.*OpenAI.*gamma.*alpha/s)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Group by vendor' }))
    expect(within(table).queryByRole('rowheader', { name: 'OpenAI' })).not.toBeInTheDocument()
    await settle(120_000)
    expect(api.count('GET', '/dashboard/api/models')).toBe(1)
    expect(api.requests.find(request => request.url.pathname.endsWith('/models'))?.url.search).toBe('')
  })

  it('copies all selected models in name order with sanitized TSV and the backend endpoint', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('isSecureContext', true)
    mountModels()
    await settle()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select beta' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select alpha' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter models' }), { target: { value: 'Gamma' } })
    fireEvent.click(screen.getByRole('button', { name: 'Copy selected (2)' }))
    await settle()
    const expected = [
      'Endpoint: http://backend.localhost:4187/v1',
      'Model ID\tModel Name\tVendor\tVersion\tMessages Route\tUpstream Endpoints\tLimits\tCapabilities\tProxy Compatibility',
      'alpha\tAlpha Model Preview / preview\tOpenAI\tv1 2\tnative-messages\t/v1/messages, /responses, /chat/completions\tcontext 200,000; prompt —; output 16,000\ttool_calls, streaming, vision\tresponses native; structured yes; output_config yes; chat tokens max_tokens; filters none; context managed',
      'beta\tBeta\tAnthropic\t4\tnative-messages\t/v1/messages, /responses, /chat/completions\tcontext 200,000; prompt —; output 16,000\ttool_calls, streaming, vision\tresponses native; structured yes; output_config yes; chat tokens max_tokens; filters none; context managed',
    ].join('\n')
    expect(writeText).toHaveBeenCalledWith(expected)
    expect(within(screen.getByRole('region', { name: 'Model catalog' })).getByText('Copied 2 models.')).toBeVisible()
  })

  it('uses the real clipboard fallback and reports failures inline', async () => {
    vi.stubGlobal('navigator', {})
    let copied = ''
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => {
      copied = (screen.getByRole('textbox', { name: '' }) as HTMLTextAreaElement).value
      return true
    }) })
    mountModels()
    await settle()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select beta' }))
    const copy = screen.getByRole('button', { name: 'Copy selected (1)' })
    copy.focus()
    fireEvent.click(copy)
    await settle()
    expect(copied).toContain('Endpoint: http://backend.localhost:4187/v1\n')
    expect(copied).toContain('\nbeta\tBeta\tAnthropic\t4\t')
    expect(copy).toHaveFocus()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
    fireEvent.click(copy)
    await settle()
    expect(within(screen.getByRole('region', { name: 'Model catalog' })).getByText(/Copy was unavailable/)).toBeVisible()
  })

  it('projects native, translated and unavailable compatibility alongside upstream metadata and limits', async () => {
    const api = createFakeFetch()
    const base = modelFixture()
    api.on('GET', '/dashboard/api/models', () => Response.json(modelsFixture({ models: [modelFixture({
      upstream: { ...base.upstream, policy: { state: 'enabled', terms: 'Subscription required' }, capabilities: { ...base.upstream.capabilities, tokenizer: 'cl100k', limits: { max_context_window_tokens: 120_000, max_prompt_tokens: 90_000, max_output_tokens: 8_000, max_inputs: 10, vision: { max_prompt_images: 3, max_prompt_image_size: 4096, supported_media_types: ['image/png'] } } } },
      effective: { ...base.effective, defaultResponsesStrategy: 'responses-chat-completions', responsesParameterFilters: ['temperature'], chatTokenParameter: 'max_completion_tokens', contextManagement: false },
    }), modelFixture({ id: 'unavailable', name: 'Unavailable route', effective: { ...base.effective, defaultResponsesStrategy: null, responsesAvailable: false, nativeResponsesAvailable: false, messagesStructuredOutput: false, outputConfig: false } })] })))
    renderDashboard({ api, url: '/dashboard/models', children: <ModelsPage /> })
    await settle()
    const row = screen.getByRole('checkbox', { name: 'Select claude-sonnet' }).closest('tr')!
    expect(row).toHaveTextContent('responses via Chat Completions')
    expect(row).toHaveTextContent('prompt 90,000')
    expect(row).toHaveTextContent('max inputs 10')
    expect(row).toHaveTextContent('images 3')
    expect(row).toHaveTextContent('image/png')
    expect(row).toHaveTextContent('cl100k')
    expect(row).toHaveTextContent('Subscription required')
    expect(row).toHaveTextContent('filters temperature')
    expect(row).toHaveTextContent('context passthrough')
    expect(within(screen.getByRole('table', { name: 'Available models' })).getByRole('row', { name: /unavailable.*Unavailable route/ })).toHaveTextContent('responses unavailable')
  })
})
