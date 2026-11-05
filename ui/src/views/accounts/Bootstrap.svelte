<script lang='ts'>
  import { untrack } from 'svelte'
  import Panel from '../../components/Panel.svelte'
  import StatusText from '../../components/StatusText.svelte'
  import { accountsUi, bootstrapRouting, page } from '../../lib/account-actions.svelte.ts'
  import { baseDashboardUrl, isLoopbackHost } from '../../lib/redirect.ts'
  import { app } from '../../lib/store.svelte.ts'

  const accounts = $derived(app.data.accounts)
  const busy = $derived(app.busy.bootstrap)
  const base = $derived(accounts?.baseHostname ?? '')

  // Prefill with the default account's hostname, but never overwrite a user edit:
  // only an empty field or one still holding the previous suggestion is replaced.
  $effect(() => {
    const suggestion = accounts?.accounts.find(account => account.isDefault)?.hostname
    if (!suggestion)
      return
    untrack(() => {
      if (!accountsUi.bootstrapHostname || accountsUi.bootstrapHostname === app.bootstrapSuggested)
        accountsUi.bootstrapHostname = suggestion
      app.bootstrapSuggested = suggestion
    })
  })

  function onsubmit(event: SubmitEvent) {
    event.preventDefault()
    void bootstrapRouting(accountsUi.bootstrapHostname)
  }
</script>

<Panel title='Enable named accounts' id='add'>
  <form class='stack' {onsubmit}>
    <div class='callout tone-info'><p class='callout-text'>Named accounts let several GitHub accounts and the M365 target share this port. Each target answers on its own hostname.</p></div>
    <label class='field'>
      Dedicated hostname
      <input id='account-bootstrap-hostname' class='mono' required maxlength='253' value={accountsUi.bootstrapHostname} oninput={event => accountsUi.bootstrapHostname = event.currentTarget.value} disabled={busy} aria-describedby='account-bootstrap-help' />
      <span id='account-bootstrap-help' class='help'>
        The current account remains the default. {#if isLoopbackHost(base)}After enabling, this page reopens at {baseDashboardUrl(base, page.location.href)}.{/if}
      </span>
    </label>
    <div class='row'>
      <button type='submit' class='btn primary' disabled={busy} aria-busy={busy || undefined}>Enable named accounts</button>
    </div>
    <StatusText id='account-bootstrap-status' line={accountsUi.bootstrapStatus} />
  </form>
</Panel>
