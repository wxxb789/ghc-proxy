<script lang='ts'>
  import ViewHeader from '../components/ViewHeader.svelte'
  import { app } from '../lib/store.svelte.ts'
  import AddAccount from './accounts/AddAccount.svelte'
  import Bootstrap from './accounts/Bootstrap.svelte'
  import M365Panel from './accounts/M365Panel.svelte'
  import Targets from './accounts/Targets.svelte'

  const accounts = $derived(app.data.accounts)
  const mode = $derived(app.accountsMode)
  // Composed summary strings keep the legacy `-` placeholder (pins).
  const summary = $derived(mode === 'unavailable'
    ? 'Named-account management is unavailable'
    : !accounts
    ? ''
    : accounts.routingEnabled
    ? `Base ${accounts.baseHostname || '-'} / default ${accounts.defaultAccount || '-'}`
    : `Legacy default ${accounts.defaultAccount || '-'} / routing not enabled`)
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
  /* Side by side only at ≥1440 (§5.3); the foundation span-5/7 split already at 1280. */
  @media (min-width: 1440px) {
    .add-slot { grid-column: span 5; }
    .m365-slot { grid-column: span 7; }
  }
</style>
