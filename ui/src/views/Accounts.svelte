<script lang='ts'>
  import ViewHeader from '../components/ViewHeader.svelte'
  import { app } from '../lib/store.svelte.ts'
  import AddAccount from './accounts/AddAccount.svelte'
  import Bootstrap from './accounts/Bootstrap.svelte'
  import M365Panel from './accounts/M365Panel.svelte'
  import Targets from './accounts/Targets.svelte'

  const accounts = $derived(app.data.accounts)
  const mode = $derived(app.accountsMode)
  // Only the routing base hostname: the default is tagged in Targets, and the legacy and 409 states explain themselves below.
  const summary = $derived(mode === 'routing' && accounts ? `Base hostname ${accounts.baseHostname || '-'}` : '')
  const formSlot = $derived(mode === 'routing' || mode === 'legacy')
</script>

<ViewHeader title='Accounts'>
  {#snippet meta()}<span id='accounts-summary'>{summary}</span>{/snippet}
</ViewHeader>
<div class='grid-12'>
  <Targets />
  {#if formSlot}
    <div class='add-slot'>{#if mode === 'routing'}<AddAccount />{:else}<Bootstrap />{/if}</div>
  {/if}
  <div class={{ 'm365-slot': formSlot }}><M365Panel /></div>
</div>

<style>
  /* Side by side only at ≥1440 (§5.3): the short Add form takes 4 columns, so the M365 panel keeps two inner columns. */
  @media (min-width: 1440px) {
    .add-slot { grid-column: span 4; }
    .m365-slot { grid-column: span 8; }
  }
</style>
