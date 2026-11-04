import type { KeyboardEvent, ReactNode } from 'react'
import { useId, useState } from 'react'

interface KeyedPoint { key: string }
interface ChartSurfaceProps<T extends KeyedPoint> {
  title: string
  rows: readonly T[]
  describe: (row: T) => string
  children: (select: (index: number) => void) => ReactNode
}

export function ChartSurface<T extends KeyedPoint>({ title, rows, describe, children }: ChartSurfaceProps<T>) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const instructions = useId()
  const value = useId()
  const selectedIndex = rows.findIndex(row => row.key === selectedKey)
  const selected = rows[selectedIndex]
  const select = (index: number) => {
    const row = rows[index]
    if (row)
      setSelectedKey(row.key)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number
    switch (event.key) {
      case 'Home':
        next = 0
        break
      case 'End':
        next = rows.length - 1
        break
      case 'ArrowRight':
      case 'ArrowDown':
        next = selectedIndex < 0 ? 0 : Math.min(rows.length - 1, selectedIndex + 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        next = selectedIndex < 0 ? rows.length - 1 : Math.max(0, selectedIndex - 1)
        break
      case 'Escape':
        event.preventDefault()
        setSelectedKey(null)
        return
      default: return
    }
    event.preventDefault()
    select(next)
  }
  return (
    <div
      className="monitor-plot"
      role="group"
      aria-label={`${title} interactive plot`}
      aria-describedby={`${instructions}${selected ? ` ${value}` : ''}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        if (event.target === event.currentTarget && selectedKey === null)
          select(0)
      }}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement))
          setSelectedKey(null)
      }}
    >
      <p className="muted" id={instructions}>Use Arrow keys, Home or End to explore values. Escape dismisses the selected value.</p>
      <div aria-hidden="true">{children(select)}</div>
      {selected && <p className="monitor-chart-value" id={value} aria-label={`${title} selected value`}>{describe(selected)}</p>}
    </div>
  )
}
