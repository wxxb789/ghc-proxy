import type { Attachment } from 'svelte/attachments'

/** Below this the list stops shrinking and the page scrolls instead. */
const MIN_HEIGHT = 320

/**
 * Caps a scroll container so that, with the page at the top, it ends at the viewport bottom (less `main`'s
 * bottom padding) however tall the content above it is: Insights open or closed, a fault strip. Recomputed
 * on window resize and whenever the page content resizes; the CSSOM write is CSP-safe.
 */
export const fitViewport: Attachment<HTMLElement> = (node) => {
  const fit = () => {
    const rect = node.getBoundingClientRect()
    const main = node.closest('main')
    const padding = main ? Number.parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0
    // The panel border (and anything else) between the scroller and the bottom of its parent.
    const below = node.parentElement!.getBoundingClientRect().bottom - rect.bottom
    node.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.floor(window.innerHeight - rect.top - window.scrollY - padding - below))}px`
  }
  fit()
  const observer = new ResizeObserver(fit)
  observer.observe(document.body)
  window.addEventListener('resize', fit)
  return () => {
    observer.disconnect()
    window.removeEventListener('resize', fit)
  }
}
