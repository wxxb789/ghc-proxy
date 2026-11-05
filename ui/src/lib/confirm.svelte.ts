// Promise-based confirmation backed by the single <ConfirmDialog> in App.

export interface ConfirmOptions {
  title: string
  body: string
  /** Label of the destructive (danger-solid) button. */
  confirmLabel: string
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (confirmed: boolean) => void
  /** Focus returns here on close, or to the view h1 when it is gone. */
  invoker: HTMLElement | null
}

export const confirmState = $state({ request: null as ConfirmRequest | null })

/** Opens the confirm dialog; resolves `true` only on the confirm button. Esc and Cancel resolve `false`. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  confirmState.request?.resolve(false)
  return new Promise((resolve) => {
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null
    confirmState.request = { ...options, resolve, invoker }
  })
}
