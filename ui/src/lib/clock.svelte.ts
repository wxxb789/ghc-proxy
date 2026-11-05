// Shared 1 s clock (spec §8.1.6). It ticks only while the tab is visible and
// at least one consumer holds a demand; it never triggers fetches.

export const clock = $state({ now: Date.now() })

let demand = 0
let timer: ReturnType<typeof setInterval> | undefined

function sync(): void {
  const wanted = demand > 0 && !document.hidden
  if (wanted && timer === undefined) {
    clock.now = Date.now()
    timer = setInterval(() => clock.now = Date.now(), 1000)
  }
  else if (!wanted && timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}

document.addEventListener('visibilitychange', sync)

/**
 * Registers one demand; returns its release function. Typical use:
 * `$effect(() => { if (needsTicking) return useClock() })`.
 */
export function useClock(): () => void {
  demand++
  sync()
  let released = false
  return () => {
    if (released)
      return
    released = true
    demand--
    sync()
  }
}
