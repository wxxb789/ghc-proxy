<script lang='ts'>
  import type { OverviewResponse } from '@contract'
  import Nil from '../../components/Nil.svelte'
  import Panel from '../../components/Panel.svelte'
  import Skeleton from '../../components/Skeleton.svelte'
  import Tag from '../../components/Tag.svelte'
  import { formatClock, formatDate, relTime } from '../../lib/format.ts'

  // Authentication table (spec §5.1): the legacy rows exactly, plus the Copilot token line.
  const { auth, stale }: { auth: OverviewResponse['auth'] | undefined, stale: boolean } = $props()

  const copilot = $derived(auth?.copilot)
  const accounts = $derived(auth?.accounts)
  const expiresIn = $derived(copilot?.expiresAt ? relTime(copilot.expiresAt) : '')
</script>

{#snippet row(service: string, status: string, identity: string, checked: string | undefined, copilotLine = false)}
  <tr>
    <td data-label='Service'>{service}</td>
    <td data-label='Status'><Tag value={status} domain='health' /></td>
    <td data-label='Identity' class='mono'>{identity}{#if copilotLine && (copilot?.expiresAt || copilot?.lastRefreshSucceeded === false)}<span class='sub'>{#if copilot.expiresAt}token expires {formatClock(copilot.expiresAt)} {#if expiresIn}({expiresIn}){/if}{/if}{#if copilot.lastRefreshSucceeded === false}<span class='fg-warn'>{copilot.expiresAt ? ' · ' : ''}last refresh failed</span>{/if}</span>{/if}</td>
    <td data-label='Last check' class='nowrap'>{#if checked}{formatDate(checked)}{:else}<Nil />{/if}</td>
  </tr>
{/snippet}

<Panel title='Authentication' id='auth' flush>
  {#snippet meta()}{#if stale}<Tag value='stale' tone='warn' />{/if}{/snippet}
  {#if !auth || !copilot || !accounts}
    <div class='pad' aria-busy='true'><Skeleton lines={3} /></div>
  {:else}
    <div class='table-scroll'>
      <table class='table'>
        <thead><tr><th scope='col'>Service</th><th scope='col'>Status</th><th scope='col'>Identity</th><th scope='col'>Last check</th></tr></thead>
        <tbody>
          {#if auth.upstream === 'm365'}
            {@render row('Microsoft 365', copilot.status, auth.identity || 'Broker account', copilot.lastRefreshAt)}
          {:else}
            {@render row('GitHub', auth.github.status, auth.github.login || auth.github.accountType, auth.github.lastValidatedAt)}
            {@render row('Copilot', copilot.status, copilot.modelsLoaded ? 'models loaded' : 'models unavailable', copilot.lastRefreshAt, true)}
          {/if}
          {#if Number.isFinite(accounts.totalAccounts)}
            {@render row('Accounts', 'ok', `${accounts.totalAccounts} total / default ${accounts.defaultAccount || '-'} / current ${accounts.currentAccount || '-'}`, undefined)}
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</Panel>

<style>
  .pad { padding: var(--s-4); }
</style>
