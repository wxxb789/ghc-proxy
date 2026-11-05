<script lang='ts'>
  import type { DashboardAccount, DashboardQuotaDetail } from '@contract'
  import CodeBlock from '../../components/CodeBlock.svelte'
  import EmptyState from '../../components/EmptyState.svelte'
  import Icon from '../../components/Icon.svelte'
  import Meter from '../../components/Meter.svelte'
  import Nil from '../../components/Nil.svelte'
  import Panel from '../../components/Panel.svelte'
  import ReasonButton from '../../components/ReasonButton.svelte'
  import Skeleton from '../../components/Skeleton.svelte'
  import StatusText from '../../components/StatusText.svelte'
  import Tag from '../../components/Tag.svelte'
  import { accountsUi, clientBaseUrl, removeTarget, setDefault } from '../../lib/account-actions.svelte.ts'
  import { formatClock, formatDate, formatQuotaPool } from '../../lib/format.ts'
  import { isLoopbackHost } from '../../lib/redirect.ts'
  import { app } from '../../lib/store.svelte.ts'
  import { quotaTone } from '../../lib/tone.ts'

  const accounts = $derived(app.data.accounts?.accounts ?? [])
  const unavailable = $derived(app.accountsMode === 'unavailable')
  const loading = $derived(!app.loadedAt.accounts)
  const open = app.ui.detailsOpen

  function removeReason(account: DashboardAccount): string | null {
    const only = accounts.length <= 1
    if (account.upstream === 'm365') {
      return only
        ? 'The M365 target is the only target and cannot be removed.'
        : account.isDefault ? 'Choose another default target before removing the M365 target.' : null
    }
    if (only)
      return 'This is the only target and cannot be removed.'
    return account.isDefault ? 'Choose another default account before removing this one.' : null
  }

  function toggle(name: string) {
    const index = open.indexOf(name)
    if (index < 0)
      open.push(name)
    else
      open.splice(index, 1)
  }

  const pools = [['Chat', 'chat'], ['Completions', 'completions']] as const
  /** An expression keeps the leading space: Svelte trims it at the start of a tag. */
  const FAILED_SUFFIX = ' failed'
</script>

{#snippet meter(detail: DashboardQuotaDetail | undefined)}
  {#if detail && !detail.unlimited}<Meter value={detail.percentRemaining} label='Premium quota remaining' tone={quotaTone(detail)} class='meter-48' />{/if}
{/snippet}

<Panel title='Targets' id='targets' flush scope='accounts'>
  {#snippet meta()}
    <StatusText id='accounts-status' line={accountsUi.status} />
  {/snippet}
  {#if unavailable}
    <EmptyState title='Named-account management is unavailable' hint="This process was started without account management (for example with a fixed GitHub token or GHE override), so accounts can't be added or switched here." />
  {:else}
    <div class='table-scroll'>
      <table class='table targets' aria-busy={loading || undefined}>
        <thead><tr><th>Target</th><th>Identity</th><th>Health</th><th>Quota</th><th class='num'>Actions</th></tr></thead>
        <tbody>
          {#if loading}
            {#each { length: 3 }, index (index)}
              <tr><td colspan='5'>{#if !index}<span class='sr-only'>Loading Accounts…</span>{/if}<Skeleton /></td></tr>
            {/each}
          {:else}
            {#each accounts as account (account.name)}
              {@const m365 = account.upstream === 'm365'}
              {@const busy = app.accountBusy[account.name]}
              {@const quota = account.quota}
              <tr>
                <td data-label='Target'>
                  <span class='row'><span id='target-{account.name}' class='mono strong' tabindex='-1'>{account.name}</span>{#if account.isDefault}<Tag value='default' kind='outline' />{/if}</span>
                  <span class='sub mono'>{account.hostname}</span>
                  <button type='button' class='btn ghost sm disclosure' aria-expanded={open.includes(account.name)} aria-controls='details-{account.name}' onclick={() => toggle(account.name)}><Icon name='chevron' />Details</button>
                </td>
                <td data-label='Identity'>
                  <span class='row'><Tag value={m365 ? 'M365' : 'GitHub'} kind='outline' /><span class='mono'>{#if account.identity || account.github.login}{account.identity || account.github.login}{:else}<Nil />{/if}</span></span>
                  <span class='sub mono'>{account.tenant}</span>
                </td>
                <td data-label='Health'>
                  {#if !m365}<span class='line'>GitHub <Tag value={account.github.status} domain='health' /></span>{/if}
                  <span class='line'>Copilot <Tag value={account.copilot.status} domain='health' /></span>
                  {#if !account.copilot.modelsLoaded}<span class='sub'><span class='fg-warn'>models unavailable</span></span>{/if}
                </td>
                <td data-label='Quota'>
                  {#if quota.status !== 'ok'}<span class='line'><Tag value={quota.status} domain='health' /></span>{/if}
                  {#if quota.status !== 'not_applicable'}
                    <span class='line'>Premium {formatQuotaPool(quota.premiumInteractions)} {@render meter(quota.premiumInteractions)}</span>
                    {#if quota.chat?.unlimited && quota.completions?.unlimited}
                      <span class='line'>Chat · Completions Unlimited</span>
                    {:else}
                      {#each pools as [label, key] (key)}
                        <span class='line'>{label} {formatQuotaPool(quota[key])}</span>
                      {/each}
                    {/if}
                    {#if quota.resetDate}<span class='sub'>Resets {formatDate(quota.resetDate)}</span>{/if}
                  {/if}
                </td>
                <td data-label='Actions' class='num'>
                  <div class='target-actions'>
                    {#if !account.isDefault}
                      <button type='button' class='btn secondary sm set-default' disabled={!!busy} aria-busy={busy === 'default' || undefined} onclick={() => setDefault(account.name)}>Set default</button>
                    {/if}
                    <ReasonButton class='danger sm remove' reason={removeReason(account)} busy={busy === 'remove'} onclick={() => removeTarget(account)}>Remove</ReasonButton>
                  </div>
                </td>
              </tr>
              {#if open.includes(account.name)}
                {@const base = clientBaseUrl(account.hostname)}
                <tr class='details'>
                  <td id='details-{account.name}' colspan='5'><div class='stack'>
                    <div class='urls'>
                      {#if m365}
                        <a class='btn secondary' href='#/accounts?section=m365'>Open M365 settings</a>
                      {:else}
                        {#each [['Client base URL', base], ['OpenAI base URL', `${base}/v1`]] as [label, text] (label)}
                          <div class='url'><span class='meta'>{label}</span><CodeBlock {text} {label} /></div>
                        {/each}
                        {#if isLoopbackHost(account.hostname)}
                          <a class='btn secondary' href='{base}/dashboard' target='_blank' rel='noreferrer'><Icon name='external' />Open this account's Dashboard<span class='sr-only'> (opens in new tab)</span></a>
                        {/if}
                      {/if}
                    </div>
                    <dl class='kv'>
                      {#if !m365}
                        <div class='kv-row'><dt>Validated</dt><dd>{#if account.github.lastValidatedAt}{formatClock(account.github.lastValidatedAt, false)}{:else}<Nil />{/if} · {account.github.accountType}</dd></div>
                      {/if}
                      <div class='kv-row'>
                        <dt>Copilot refresh</dt>
                        <dd>{#if account.copilot.lastRefreshAt}{formatClock(account.copilot.lastRefreshAt, false)}{:else}<Nil />{/if}{#if account.copilot.lastRefreshSucceeded === false}<span class='fg-warn'>{FAILED_SUFFIX}</span>{/if}{#if account.copilot.expiresAt}{` · expires ${formatClock(account.copilot.expiresAt, false)}`}{/if}</dd>
                      </div>
                    </dl>
                  </div></td>
                </tr>
              {/if}
            {:else}
              <tr><td class='empty-cell' colspan='5'><EmptyState title='No targets configured.' /></td></tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</Panel>

<style>
  /* Buttons right-aligned on one line (the default row leaves the Set default cell empty, so Remove stays aligned);
     a disabled reason reads below them, left-aligned and capped at ~28ch. */
  .target-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: var(--s-1) var(--s-2); }
  .set-default { grid-area: 1 / 2; }
  .target-actions > :global(.remove) { grid-area: 1 / 3; }
  .target-actions :global(.reason) { grid-column: 1 / -1; max-width: 28ch; margin: 0; text-align: left; }
  .disclosure { margin: var(--s-1) 0 0 -8px; }
  .disclosure :global(.icon) { transform: rotate(-90deg); }
  .disclosure[aria-expanded='true'] :global(.icon) { transform: none; }
  .line { display: flex; align-items: center; gap: var(--s-2); }
  .details > td { padding-bottom: var(--s-4); background: var(--bg-0); }
  .details .stack { gap: var(--s-3); }
  /* URL blocks side by side under small captions, the Dashboard link inline at the end; the kv sits below. */
  .urls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--s-2) var(--s-4); }
  .url { display: grid; flex: 1 1 16rem; gap: var(--s-1); min-width: 0; max-width: 360px; }
  .details .kv { max-width: 720px; }
  .details .kv-row { min-height: 0; padding: 2px 0; }
  /* Cards (§5.3): name + actions, hostname, identity | health, quota; details below. ≤1100 rather than ≤900:
     beside the rail the five columns need about 710 px. */
  @media (max-width: 1100px) {
    .targets thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    .targets tbody tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-2) var(--s-4); padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--line); }
    /* :first-child / :last-child outrank the global first/last cell padding. */
    .targets td, .targets td:is(:first-child, :last-child) { height: auto; padding: 0; border: 0; }
    .targets td:is([colspan], [data-label='Quota']) { grid-column: 1 / -1; }
    .targets td[data-label='Actions'] { grid-area: 1 / 2; }
    .target-actions :global(.reason) { justify-self: end; }
    .targets tr.details { background: var(--bg-0); }
    .targets td[data-label]:not(:first-child, :last-child)::before { content: attr(data-label); display: block; font-size: 11px; line-height: 16px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--text-3); }
  }
  @media (max-width: 560px) {
    .targets tbody tr { grid-template-columns: minmax(0, 1fr); }
    .targets td[data-label='Actions'] { grid-area: auto; }
    .target-actions :global(.reason) { justify-self: auto; }
    .target-actions { grid-template-columns: 1fr 1fr; }
    .set-default { grid-area: 1 / 1; }
    .target-actions > :global(.remove) { grid-area: 1 / 2; }
    /* The global reflow labels every cell; the name and the actions need no caption, as in the ≤1100 cards. */
    .targets td:is(:first-child, :last-child)::before { content: none; }
    .url { flex-basis: 100%; max-width: none; }
  }
</style>
