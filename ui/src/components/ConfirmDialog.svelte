<script lang='ts'>
  import { confirmState } from '../lib/confirm.svelte.ts'

  // The single host for `confirm()`. Cancel takes initial focus; Esc and Cancel resolve false.
  let dialog: HTMLDialogElement
  let cancel = $state<HTMLButtonElement>()
  const request = $derived(confirmState.request)

  $effect(() => {
    if (request && cancel && !dialog.open) {
      dialog.returnValue = ''
      dialog.showModal()
      cancel.focus()
    }
  })

  function onclose() {
    const closed = confirmState.request
    if (!closed)
      return
    confirmState.request = null
    closed.resolve(dialog.returnValue === 'confirm')
    const target = closed.invoker?.isConnected ? closed.invoker : document.getElementById('view-h1')
    target?.focus()
  }
</script>

<dialog bind:this={dialog} class='dialog' aria-labelledby='confirm-h' {onclose}>
  {#if request}
    <h2 id='confirm-h'>{request.title}</h2>
    <p class='dialog-body'>{request.body}</p>
    <div class='dialog-actions'>
      <button bind:this={cancel} type='button' class='btn secondary' onclick={() => dialog.close('')}>Cancel</button>
      <button type='button' class='btn danger-solid' onclick={() => dialog.close('confirm')}>{request.confirmLabel}</button>
    </div>
  {/if}
</dialog>
