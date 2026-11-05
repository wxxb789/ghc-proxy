import { afterEach, describe, expect, it } from 'vitest'
import { matchShortcut, readShortcutsEnabled, writeShortcutsEnabled } from './shortcuts.ts'

function press(key: string, init: KeyboardEventInit = {}, target: Element = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'target', { value: target })
  return event
}

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
})

describe('matchShortcut (spec §8.4)', () => {
  it('maps 1–5, /, l and ?', () => {
    expect(matchShortcut(press('1'), true)).toEqual({ kind: 'view', view: 'overview' })
    expect(matchShortcut(press('5'), true)).toEqual({ kind: 'view', view: 'behavior' })
    expect(matchShortcut(press('/'), true)).toEqual({ kind: 'filter' })
    expect(matchShortcut(press('l'), true)).toEqual({ kind: 'live' })
    expect(matchShortcut(press('?', { shiftKey: true }), true)).toEqual({ kind: 'help' })
    expect(matchShortcut(press('6'), true)).toBeNull()
    expect(matchShortcut(press('r'), true)).toBeNull()
  })

  it('ignores modifiers and IME composition', () => {
    expect(matchShortcut(press('1', { ctrlKey: true }), true)).toBeNull()
    expect(matchShortcut(press('1', { altKey: true }), true)).toBeNull()
    expect(matchShortcut(press('1', { metaKey: true }), true)).toBeNull()
    expect(matchShortcut(press('1', { isComposing: true }), true)).toBeNull()
  })

  it('ignores keys typed into fields and editable content', () => {
    document.body.innerHTML = '<input id="i"><textarea id="t"></textarea><select id="s"></select><div contenteditable="true"><span id="c">x</span></div>'
    for (const id of ['i', 't', 's', 'c'])
      expect(matchShortcut(press('l', {}, document.getElementById(id)!), true)).toBeNull()
  })

  it('ignores keys while a dialog is open', () => {
    document.body.innerHTML = '<dialog open></dialog>'
    expect(matchShortcut(press('2'), true)).toBeNull()
  })

  it('does nothing when switched off', () => {
    expect(matchShortcut(press('2'), false)).toBeNull()
  })
})

describe('off switch persistence', () => {
  it('defaults to on and stores only "off"', () => {
    expect(readShortcutsEnabled()).toBe(true)
    writeShortcutsEnabled(false)
    expect(localStorage.getItem('ghc-proxy-dashboard-shortcuts')).toBe('off')
    expect(readShortcutsEnabled()).toBe(false)
    writeShortcutsEnabled(true)
    expect(localStorage.getItem('ghc-proxy-dashboard-shortcuts')).toBeNull()
    expect(readShortcutsEnabled()).toBe(true)
  })
})
