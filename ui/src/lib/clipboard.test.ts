import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CodeBlock from '../components/CodeBlock.svelte'
import { copyText } from './clipboard.ts'

beforeEach(() => {
  // Insecure context (e.g. http://0.0.0.0): no async Clipboard API, so the legacy path runs.
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  document.execCommand = vi.fn(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('copyText legacy fallback', () => {
  it('returns focus to the control that started the copy', async () => {
    // Chromium's select() focuses the textarea; jsdom's does not, so mimic it.
    vi.spyOn(HTMLTextAreaElement.prototype, 'select').mockImplementation(function (this: HTMLTextAreaElement) {
      this.focus()
    })
    const button = document.createElement('button')
    document.body.append(button)
    button.focus()
    await copyText('abc')
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(button).toHaveFocus()
    button.remove()
  })
})

describe('copy status lines', () => {
  it('changes the live region on every attempt, so a repeated outcome is announced again', async () => {
    document.execCommand = vi.fn(() => false)
    render(CodeBlock, { text: 'abc', label: 'request ID' })
    const button = screen.getByRole('button', { name: 'Copy request ID' })
    const status = screen.getByRole('status')
    await fireEvent.click(button)
    await waitFor(() => expect(status).toHaveTextContent('Copy failed'))
    const seen: string[] = []
    const observer = new MutationObserver(() => seen.push(status.textContent ?? ''))
    observer.observe(status, { childList: true, characterData: true, subtree: true })
    await fireEvent.click(button)
    await waitFor(() => expect(seen.at(-1)).toBe('Copy failed'))
    observer.disconnect()
    expect(seen).toContain('')
  })
})
