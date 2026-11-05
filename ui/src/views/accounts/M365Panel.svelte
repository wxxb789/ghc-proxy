<script lang='ts'>
  import type { M365DashboardState, MscAccount } from '@contract'
  import CodeBlock from '../../components/CodeBlock.svelte'
  import Icon from '../../components/Icon.svelte'
  import Lamp from '../../components/Lamp.svelte'
  import Panel from '../../components/Panel.svelte'
  import ReasonButton from '../../components/ReasonButton.svelte'
  import Tag from '../../components/Tag.svelte'
  import { removeTarget } from '../../lib/account-actions.svelte.ts'
  import { selectValue } from '../../lib/actions/selectValue.ts'
  import { formatClock } from '../../lib/format.ts'
  import {
    m365AccountCandidates,
    m365EndpointOptions,
    m365EndpointStatus,
    m365OnboardingAvailable,
    m365RegisterAccount,
    m365SelectedAccount,
    m365TargetAction,
    registerM365,
    saveM365Endpoint,
    saveM365Hostname,
    selectM365Account,
    signInM365,
  } from '../../lib/m365-actions.svelte.ts'
  import { m365StatusText, probeM365 } from '../../lib/m365-load.svelte.ts'
  import { app } from '../../lib/store.svelte.ts'

  const m365 = app.m365
  const busy = app.busy
  const view = $derived(m365.view)
  const onboarding = $derived(m365OnboardingAvailable())
  /** Endpoint + register mutual exclusion (T:499-535). */
  const locked = $derived(!onboarding || busy.m365Target)
  const endpoints = $derived(m365EndpointOptions())
  const brokerAccounts = $derived(m365.probe?.accounts ?? [])
  const registerAccount = $derived(m365RegisterAccount())
  const candidates = $derived(m365AccountCandidates())
  const selectedAccount = $derived(m365SelectedAccount(candidates))
  const signInBlocked = $derived(!!m365.probe && (!m365.probe.platformSupported || !m365.probe.helperAvailable))
  const unavailable = $derived(view?.availability?.status === 'unavailable')
  const routing = $derived(view?.routing ?? [])
  const removeReason = $derived(routing.length <= 1
    ? 'The M365 target is the only target and cannot be removed.'
    : routing.some(row => row.kind === 'm365' && row.isDefault) ? 'Choose another default target before removing the M365 target.' : null)
  /**
   * Resting text ("Ready.", "Not added.", the cause the callout shows) repeats the header tag:
   * it stays in the live region but takes no row. Progress, outcomes, errors and the onboarding reason stay visible.
   */
  const statusResting = $derived(!!view && !m365.statusIsError && (view.registered || onboarding) && m365.status === m365StatusText(view))

  function summaryParts(state: M365DashboardState): string[] {
    const parts: string[] = []
    if (state.username)
      parts.push(state.username)
    else if (state.account)
      parts.push(state.account.includes('@') ? state.account : `account ${state.account.slice(0, 12)}…`)
    parts.push(`${state.modelCount} models`)
    if (state.tokenExpiresAt)
      parts.push(`token until ${formatClock(state.tokenExpiresAt, false)}`)
    return parts
  }

  const accountLabel = (account: MscAccount) => `${account.upn || 'Email unavailable'} — ${account.homeAccountId.slice(0, 12)}… (${account.environment})`

  /** Every form handler prevents the default submission (`form-action 'none'`). */
  const submit = (action: () => unknown) => (event: SubmitEvent) => {
    event.preventDefault()
    void action()
  }
</script>

{#snippet accountOptions(accounts: MscAccount[])}
  {#each accounts as account (account.homeAccountId)}
    <option value={account.homeAccountId} title={account.homeAccountId}>{accountLabel(account)}</option>
  {/each}
{/snippet}

<Panel title='M365 Copilot target' id='m365-panel' headingId='m365-h'>
  {#snippet meta()}
    {#if view?.registered}
      <Tag value={view.availability?.status ?? 'unknown'} domain='availability' />
    {:else if view}
      <Tag value={onboarding ? 'not added' : 'unavailable'} tone='hollow' />
    {/if}
  {/snippet}

  <div class='m365'>
    <p id='m365-status' class={['status-line', m365.statusIsError && 'is-error', m365.status === 'Working…' && 'is-busy', m365.status === 'Saved.' && 'is-ok', statusResting && 'sr-only']}
       role='status' aria-live='polite'>{m365.status}</p>

    {#if view}
      <div class='m365-cols'>
        <div class='stack'>
          {#if view.registered}
            <div id='m365-active' class='stack'>
              <p id='m365-summary' class='mono'>{summaryParts(view).join(' · ')}</p>
              {#if unavailable}
                <div class='callout tone-bad'><Icon name='x' /><p class='callout-text'>{view.availability?.cause || 'The target is unavailable.'}</p></div>
              {/if}

              <form id='m365-form' class='m365-form' onsubmit={submit(selectM365Account)}>
                <label class='field'>Broker account
                  <span class='select'>
                    <select id='m365-account' title={selectedAccount} {@attach selectValue(selectedAccount, candidates)} onchange={event => m365.drafts.account = event.currentTarget.value}>
                      {@render accountOptions(candidates)}
                    </select>
                  </span>
                </label>
                <button type='submit' class='btn secondary' aria-busy={busy.m365Account || undefined} disabled={!candidates.length || busy.m365Account}>Use this account</button>
                <button type='button' class='btn secondary' aria-busy={busy.m365Probe || undefined} disabled={busy.m365Probe} onclick={probeM365}>Refresh broker accounts</button>
              </form>

              <form id='m365-hostname-form' class='m365-form' onsubmit={submit(saveM365Hostname)}>
                <label class='field'>Hostname
                  <input id='m365-hostname' type='text' maxlength='253' required autocomplete='off' class='mono'
                         value={m365.drafts.hostname} oninput={(event) => {
                           m365.drafts.hostname = event.currentTarget.value
                           m365.dirty.hostname = true
                         }}>
                </label>
                <button type='submit' class='btn secondary' aria-busy={busy.m365Hostname || undefined} disabled={busy.m365Hostname}>Save hostname</button>
              </form>

              <!-- Only when Targets can't list them (409): otherwise these rows copy the Targets table. -->
              {#if app.accountsMode === 'unavailable'}
                <div>
                  <h3 class='label'>Routing</h3>
                  {#if routing.length}
                    <ul id='m365-routing' class='routing'>
                      {#each routing as row (row.target)}
                        <li><span class='mono'>{row.target} → {row.hostname}</span> <Tag kind='outline' value={row.kind === 'm365' ? 'M365' : 'GitHub'} /> {#if row.isDefault}<Tag kind='outline' value='default' />{/if}</li>
                      {/each}
                    </ul>
                  {:else}
                    <p id='m365-routing' class='muted'>No targets registered yet.</p>
                  {/if}
                </div>
              {/if}

              <div>
                <h3 class='label'>Client environment</h3>
                <CodeBlock id='m365-client' label='Client environment'
                           text={`ANTHROPIC_BASE_URL=${view.client?.baseUrl ?? ''}\nANTHROPIC_AUTH_TOKEN=dummy-token\nANTHROPIC_MODEL=${view.client?.model ?? ''}`} />
                <p class='hint'>M365 serves Anthropic Messages only.</p>
              </div>
            </div>
          {:else}
            <ol id='m365-absent' class='steps stack'>
              <li class='stack'>
                <p>Serve the M365 Copilot gateway next to your GitHub accounts on this same port. Requires Windows, the msc-auth helper, and a work account with an M365 Copilot subscription.</p>
                <div>
                  <ReasonButton reason={onboarding ? null : 'Onboarding is unavailable for this process.'} busy={busy.m365Probe} onclick={probeM365}>Check prerequisites</ReasonButton>
                </div>
              </li>
              <li>If your work account isn't listed, sign in with Microsoft.</li>
              {#if brokerAccounts.length}
                <li>
                  <form id='m365-register-form' class='m365-form' onsubmit={submit(registerM365)}>
                    <label class='field'>Broker account
                      <span class='select'>
                        <select id='m365-register-account' title={registerAccount}
                                {@attach selectValue(registerAccount, brokerAccounts)} onchange={event => m365.drafts.registerAccount = event.currentTarget.value}>
                          {@render accountOptions(brokerAccounts)}
                        </select>
                      </span>
                    </label>
                    <label class='field'>Hostname
                      <input id='m365-register-hostname' type='text' maxlength='253' required autocomplete='off' class='mono' value={m365.drafts.registerHostname} oninput={event => m365.drafts.registerHostname = event.currentTarget.value}>
                    </label>
                    <button id='m365-register' type='submit' class='btn primary' aria-busy={m365TargetAction.current === 'register' || undefined} disabled={locked}>Add M365 target</button>
                  </form>
                </li>
              {/if}
            </ol>
          {/if}
        </div>

        <div class='stack'>
          <section class='stack' aria-labelledby='m365-endpoint-h'>
            <h3 id='m365-endpoint-h'>Upstream endpoint</h3>
            <form id='m365-endpoint-form' class='m365-form' onsubmit={submit(() => saveM365Endpoint(false))}>
              <label class='field'><span class='sr-only'>Upstream endpoint</span>
                <span class='select'>
                  <select id='m365-endpoint' class='mono' required disabled={locked} aria-describedby='m365-endpoint-warning' title={m365.drafts.endpoint}
                          {@attach selectValue(m365.drafts.endpoint, endpoints)} onchange={(event) => {
                            m365.drafts.endpoint = event.currentTarget.value
                            m365.dirty.endpoint = true
                          }}>
                    {#each endpoints as endpoint (endpoint)}<option value={endpoint} title={endpoint}>{endpoint}</option>{/each}
                  </select>
                </span>
              </label>
              <button id='m365-endpoint-save' type='submit' class='btn secondary' aria-busy={m365TargetAction.current === 'endpoint' || undefined} disabled={locked}>Use endpoint</button>
            </form>
            <div class='callout tone-warn'>
              <Icon name='triangle' />
              <p id='m365-endpoint-warning' class='callout-text'>Your Microsoft access token is sent to the selected upstream endpoint. Only use endpoints you trust.</p>
            </div>
            <form id='m365-custom-endpoint-form' class='m365-form' onsubmit={submit(() => saveM365Endpoint(true))}>
              <label class='field'>Custom HTTPS endpoint
                <input id='m365-custom-endpoint' type='url' required autocomplete='off' class='mono' placeholder='https://your-endpoint.example/api/v1/llmapi'
                       disabled={locked} aria-describedby='m365-endpoint-warning' value={m365.drafts.custom} oninput={event => m365.drafts.custom = event.currentTarget.value}>
              </label>
              <button id='m365-custom-endpoint-save' type='submit' class='btn secondary' aria-busy={m365TargetAction.current === 'custom' || undefined} disabled={locked}>Add and use endpoint</button>
            </form>
            <p id='m365-endpoint-status' class={['status-line', 'mono', m365EndpointStatus.tone && `is-${m365EndpointStatus.tone === 'ok' ? 'ok' : 'error'}`]}
               role='status' aria-live='polite'>{m365EndpointStatus.text}</p>
          </section>

          {#if onboarding}
            <section class='stack' aria-labelledby='m365-sign-in-h'>
              <h3 id='m365-sign-in-h'>Microsoft sign-in</h3>
              <form id='m365-sign-in-form' class='m365-form' onsubmit={submit(signInM365)}>
                <label class='field'><span>Account email <span class='optional'>(optional)</span></span>
                  <input id='m365-sign-in-upn' type='email' autocomplete='username' placeholder='you@company.com' aria-describedby='m365-sign-in-help' value={m365.drafts.signInUpn} oninput={event => m365.drafts.signInUpn = event.currentTarget.value}>
                </label>
                <button id='m365-sign-in' type='submit' class='btn secondary' aria-busy={busy.m365SignIn || undefined} disabled={signInBlocked || busy.m365SignIn} aria-describedby='m365-sign-in-help'>Sign in another M365 account</button>
              </form>
              <p id='m365-sign-in-help' class='hint'>Only Windows broker accounts are listed. Choose a work account with an M365 Copilot subscription.</p>
            </section>
          {/if}
          <div id='m365-readiness' class='readiness' role='status' aria-live='polite'>
            {#if m365.readiness.length}
              <ul>
                {#each m365.readiness as line, index (index)}
                  <li class={{ 'fg-bad': line.tone === 'bad' }}>{#if line.tone}<Lamp tone={line.tone} />{:else}<span class='lamp-slot'></span>{/if}{line.text}</li>
                {/each}
              </ul>
            {/if}
          </div>
        </div>
      </div>
      {#if view.registered}
        <div class='danger-zone'>
          <ReasonButton class='danger' reason={removeReason} busy={app.accountBusy.m365 === 'remove'}
                        onclick={() => void removeTarget({ name: 'm365', hostname: view.hostname ?? '' })}>Remove M365 target</ReasonButton>
        </div>
      {/if}
    {/if}
  </div>
</Panel>

<style>
  .m365 { display: grid; gap: var(--s-4); container-type: inline-size; }
  .m365-cols { display: grid; gap: var(--s-6); }
  /* Panel ≥760 px = this container + border (2 × 1px) + panel-body padding (2 × --s-4); ≤900 always stacks (Target first). */
  @container (min-width: 726px) {
    .m365-cols { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  }
  @media (max-width: 900px) {
    .m365-cols { grid-template-columns: minmax(0, 1fr); }
  }
  .m365-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--s-2) var(--s-3); }
  .m365-form .field { flex: 1 1 14rem; min-width: 0; }
  .m365-form .field :is(input, select) { width: 100%; }
  /* The full gateway host stays readable beside the trust warning; Use endpoint wraps below. */
  #m365-endpoint-form .field { flex-basis: 100%; }
  .label { margin-bottom: var(--s-1); font-size: 12px; line-height: 16px; font-weight: 500; color: var(--text-2); }
  .routing { display: grid; gap: var(--s-1); }
  .routing li, .readiness li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2); }
  .readiness { display: grid; gap: var(--s-1); font-size: 12px; line-height: 16px; color: var(--text-2); }
  /* A toneless line keeps the lamp's 8 px slot, so every line's text starts at the same x. */
  .lamp-slot { flex: none; width: 8px; }
  /* Separated from the setup flow, spanning both columns. */
  .danger-zone { padding-top: var(--s-4); border-top: 1px solid var(--line); }
  #m365-summary { overflow-wrap: anywhere; color: var(--text-2); }
  @media (max-width: 560px) {
    .m365-form > .btn { width: 100%; }
  }
</style>
