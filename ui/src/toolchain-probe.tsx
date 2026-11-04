import { useRef } from 'react'
import { ChartProbe } from './chart-probe'

const samplePoints = [
  { label: 'A', requests: 2 },
  { label: 'B', requests: 5 },
  { label: 'C', requests: 3 },
]

export function ToolchainProbe() {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const openerRef = useRef<HTMLButtonElement>(null)

  return (
    <main className="mx-auto max-w-4xl space-y-8 px-5 py-12 sm:px-8">
      <header className="space-y-3">
        <p className="text-sm font-semibold tracking-wide text-ink-muted">ghc-proxy Dashboard</p>
        <h1 className="text-4xl font-semibold tracking-tight">Frontend compatibility probe</h1>
        <p className="text-ink-muted">This build exercises the chart, static styles, and native dialog before Dashboard integration.</p>
      </header>
      <section className="rounded-3xl border border-border bg-surface p-6 sm:p-8">
        <ChartProbe points={samplePoints} />
      </section>
      <button
        ref={openerRef}
        type="button"
        className="rounded-xl bg-completed px-5 py-3 font-semibold text-surface"
        onClick={() => dialogRef.current?.showModal()}
      >
        Open native dialog
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby="probe-dialog-title"
        className="m-auto max-w-md space-y-5 rounded-3xl border border-border bg-surface p-8 text-ink"
        onClose={() => openerRef.current?.focus()}
      >
        <h2 id="probe-dialog-title" className="text-2xl font-semibold">Native dialog compatibility</h2>
        <p className="text-ink-muted">Escape and the close button dismiss this browser-managed modal.</p>
        <form method="dialog">
          <button type="submit" className="rounded-xl border border-border px-5 py-3 font-semibold">Close</button>
        </form>
      </dialog>
    </main>
  )
}
