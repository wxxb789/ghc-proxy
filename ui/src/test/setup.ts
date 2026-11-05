import '@testing-library/jest-dom/vitest'

// jsdom lacks the Web Animations API that Svelte 5 transitions use.
if (!Element.prototype.animate) {
  Element.prototype.animate = function animate() {
    const animation = {
      cancel() {},
      finish() {},
      onfinish: null as null | (() => void),
      currentTime: 0,
      playState: 'finished',
    }
    queueMicrotask(() => animation.onfinish?.())
    return animation as unknown as Animation
  }
}

// jsdom lacks modal dialogs; the real behaviour is verified in a browser.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, returnValue?: string) {
    this.open = false
    if (returnValue !== undefined)
      this.returnValue = returnValue
    this.dispatchEvent(new Event('close'))
  }
}
