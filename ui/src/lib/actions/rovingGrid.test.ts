import { afterEach, describe, expect, it } from 'vitest'
import { rovingGrid } from './rovingGrid.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

function grid(count: number, selected = -1) {
  document.body.innerHTML = `<table><tbody>${Array.from({ length: count }, (_, index) =>
    `${index === 2 ? '<tr class="group"><th>Group</th></tr>' : ''}<tr data-row tabindex="-1" aria-selected="${index === selected}" id="r${index}"><td>${index}</td></tr>`).join('')}</tbody></table>`
  const moved: string[] = []
  const table = document.querySelector('table')!
  const action = rovingGrid(table, { onMove: row => moved.push(row.id) })
  const key = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  return { table, moved, key, action, stops: () => Array.from(table.querySelectorAll<HTMLElement>('[tabindex="0"]'), row => row.id) }
}

describe('rovingGrid', () => {
  it('keeps exactly one tab stop, preferring the selected row', () => {
    expect(grid(4, 3).stops()).toEqual(['r3'])
    expect(grid(4).stops()).toEqual(['r0'])
  })

  it('moves with arrows, Home/End and PageUp/PageDown, skipping group rows', () => {
    const { moved, key, stops } = grid(15)
    document.getElementById('r0')!.focus()
    key('ArrowDown')
    key('ArrowDown')
    expect(document.activeElement?.id).toBe('r2')
    key('End')
    key('PageUp')
    key('Home')
    key('PageDown')
    key('ArrowUp')
    expect(moved).toEqual(['r1', 'r2', 'r14', 'r4', 'r0', 'r10', 'r9'])
    expect(stops()).toEqual(['r9'])
  })

  it('restores a tab stop when the stop row is removed', async () => {
    const { table, stops, action } = grid(3)
    table.querySelector('#r0')!.remove()
    await Promise.resolve()
    expect(stops()).toEqual(['r1'])
    action?.destroy?.()
  })
})
