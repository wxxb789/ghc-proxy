<script lang='ts'>
  import { writeShortcutsEnabled } from '../lib/shortcuts.ts'
  import { app } from '../lib/store.svelte.ts'

  const KEYS: Array<[string, string]> = [
    ['1 – 5', 'Overview, Requests, Accounts, Models, Behavior'],
    ['/', 'Focus the view filter (Requests, Models)'],
    ['l', 'Turn Live updates on or off'],
    ['?', 'Open this dialog'],
    ['Esc', 'Close a popover, the menu or a dialog; clear a filter'],
    ['↑ ↓ Home End', 'Move through table rows'],
  ]

  let dialog: HTMLDialogElement
  let invoker: HTMLElement | null = null

  $effect(() => {
    if (app.ui.shortcutsOpen && !dialog.open) {
      invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.showModal()
    }
  })

  function onclose() {
    app.ui.shortcutsOpen = false
    const target = invoker?.isConnected ? invoker : document.getElementById('view-h1')
    target?.focus()
  }

  function toggle(event: Event & { currentTarget: HTMLInputElement }) {
    app.prefs.shortcuts = event.currentTarget.checked
    writeShortcutsEnabled(app.prefs.shortcuts)
  }
</script>

<dialog bind:this={dialog} class='dialog' aria-labelledby='shortcuts-h' {onclose}>
  <h2 id='shortcuts-h'>Keyboard shortcuts</h2>
  <label class='check'><input type='checkbox' checked={app.prefs.shortcuts} onchange={toggle} />Single-key shortcuts</label>
  <p class='hint'>Turns the single-character keys off. Arrow keys and Esc always work.</p>
  <dl class='kv'>
    {#each KEYS as [keys, action] (keys)}<div class='kv-row'><dt><kbd>{keys}</kbd></dt><dd>{action}</dd></div>{/each}
  </dl>
  <div class='dialog-actions'><button type='button' class='btn secondary' onclick={() => dialog.close()}>Close</button></div>
</dialog>
