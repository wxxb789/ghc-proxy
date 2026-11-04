import { notifyManager } from '@tanstack/react-query'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'

afterEach(cleanup)

// Nested timer notifications gain 1 ms under fake clocks; notify at the accepted query deadline.
notifyManager.setScheduler(queueMicrotask)

// jsdom does not implement native dialog top-layer methods. Browser proof remains separate.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
}
