<script lang='ts'>
  import Panel from '../../components/Panel.svelte'
  import StatusText from '../../components/StatusText.svelte'
  import { clientBaseUrl } from '../../lib/account-actions.svelte.ts'
  import { addForm, startDeviceAuth } from '../../lib/device-auth.svelte.ts'
  import { app } from '../../lib/store.svelte.ts'
  import DeviceCode from './DeviceCode.svelte'

  // The lock is store-owned: fields stay disabled from submit until a terminal state or a poll error.
  const locked = $derived(app.deviceAuth.busy)

  // One-way values plus input handlers (no `bind:value`): keeps the input-binding runtime out of the bundle.
  function onNameInput(event: Event & { currentTarget: HTMLInputElement }) {
    addForm.name = event.currentTarget.value
    if (!addForm.hostnameDirty)
      addForm.hostname = addForm.name ? `${addForm.name.toLowerCase()}.localhost` : ''
  }

  function onsubmit(event: SubmitEvent) {
    event.preventDefault()
    void startDeviceAuth({ accountName: addForm.name, hostname: addForm.hostname, gheDomain: addForm.gheDomain })
  }
</script>

<Panel title='Add GitHub account' id='add'>
  <div class='stack'>
    <form id='account-add-form' class='stack' {onsubmit}>
      <fieldset class='form-grid' disabled={locked}>
        <label class='field'>
          Name
          <input id='account-name' class='mono' required maxlength='64' autocomplete='off' value={addForm.name} oninput={onNameInput} />
        </label>
        <label class='field'>
          Hostname
          <input class='mono' required maxlength='253' placeholder='account.localhost' autocomplete='off' value={addForm.hostname} oninput={(event) => {
            addForm.hostname = event.currentTarget.value
            addForm.hostnameDirty = true
          }} />
        </label>
        <label class='field full'>
          <span>GHE tenant <span class='optional'>(optional)</span></span>
          <input class='mono' placeholder='company.ghe.com' autocomplete='off' value={addForm.gheDomain} oninput={event => addForm.gheDomain = event.currentTarget.value} />
        </label>
        {#if addForm.hostname}<p class='full meta'>Clients will reach this account at <span class='mono'>{clientBaseUrl(addForm.hostname)}</span></p>{/if}
        <div class='full row'>
          <button type='submit' class='btn primary' aria-busy={locked || undefined}>Authenticate with GitHub</button>
        </div>
      </fieldset>
      <div>
        <StatusText id='account-add-status' line={addForm.status} />
        {#if addForm.retryHint}<p class='hint'>Check the details and select Authenticate with GitHub again.</p>{/if}
      </div>
    </form>
    {#if app.deviceAuth.session}<DeviceCode session={app.deviceAuth.session} live={locked} />{/if}
  </div>
</Panel>

<style>
  fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
</style>
