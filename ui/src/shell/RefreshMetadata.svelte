<script lang='ts'>
  import Icon from '../components/Icon.svelte'
  import ReasonButton from '../components/ReasonButton.svelte'
  import { refreshMetadata } from '../lib/poller.svelte.ts'
  import { app, faults, metadataUnavailableReason } from '../lib/store.svelte.ts'

  // The metadata fault shows here as one line (and in Issues), never as a strip.
  const fault = $derived(faults.metadata)
</script>

<ReasonButton class='secondary full' reason={metadataUnavailableReason()} busy={app.busy.metadata}
              title='Re-fetch GitHub identity, quota and models from upstream for every account.' onclick={refreshMetadata}>
  <Icon name='refresh' />Refresh metadata
</ReasonButton>
{#if fault}<p class='status-line is-error'>{fault.message}</p>{/if}
