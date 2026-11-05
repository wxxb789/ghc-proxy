<script lang='ts'>
  import { writeShortcutsEnabled } from '../lib/shortcuts.ts'
  import { app } from '../lib/store.svelte.ts'

  // The checkbox switches only the single-key group; the second group always works.
  const SINGLE_KEYS: Array<[string, string]> = [
    ['1 – 5', 'Overview, Requests, Accounts, Models, Behavior'],
    ['/', 'Focus the view filter (Requests, Models)'],
    ['l', 'Turn Live updates on or off'],
    ['?', 'Open this dialog'],
  ]
  const ALWAYS_KEYS: Array<[string, string]> = [
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
  <div class='shortcut-groups'>
    <label class='check'><input type='checkbox' checked={app.prefs.shortcuts} onchange={toggle} />Single-key shortcuts</label>
    <dl class={['kv', !app.prefs.shortcuts && 'is-off']}>
      {#each SINGLE_KEYS as [keys, action] (keys)}<div class='kv-row'><dt><kbd>{keys}</kbd></dt><dd>{action}</dd></div>{/each}
    </dl>
    <p class='placard'>Always on</p>
    <dl class='kv'>
      {#each ALWAYS_KEYS as [keys, action] (keys)}<div class='kv-row'><dt><kbd>{keys}</kbd></dt><dd>{action}</dd></div>{/each}
    </dl>
  </div>
  <div class='dialog-actions'><button type='button' class='btn secondary' onclick={() => dialog.close()}>Close</button></div>
</dialog>
