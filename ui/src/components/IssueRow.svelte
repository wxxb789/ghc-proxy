<script lang='ts'>
  import type { Issue, IssueAction } from '../lib/insights.ts'
  import { formatClock } from '../lib/format.ts'
  import { runIssueAction } from '../lib/health.svelte.ts'
  import { revisit } from '../lib/router.svelte.ts'
  import { app, metadataUnavailableReason } from '../lib/store.svelte.ts'
  import Icon from './Icon.svelte'
  import ReasonButton from './ReasonButton.svelte'

  // `onaction` runs after any action (the popover closes itself and places focus by kind).
  const { issue, onaction }: { issue: Issue, onaction?: (action: IssueAction) => void } = $props()

  function run(action: IssueAction) {
    runIssueAction(action)
    onaction?.(action)
  }

  // A link to the current hash fires no hashchange: focus its target directly.
  function follow(event: MouseEvent, action: IssueAction) {
    if (action.href && revisit(action.href))
      event.preventDefault()
    onaction?.(action)
  }
</script>

<li class='issue tone-{issue.tone}' tabindex='-1'>
  {#if issue.tone === 'info'}<span class='issue-dot' aria-hidden='true'></span>{:else}<Icon name={issue.tone === 'bad' ? 'x' : 'triangle'} />{/if}
  <div class='issue-text'>
    <p class='issue-title'>{issue.title}</p>
    {#if issue.body || issue.asOf}<p class='issue-body'>{issue.body ?? ''} {#if issue.asOf}<span class='muted'>as of {formatClock(issue.asOf)}</span>{/if}</p>{/if}
  </div>
  {#if issue.since}<span class='issue-meta'>since {formatClock(issue.since, false)} {#if issue.count && issue.count > 1}· ×{issue.count}{/if}</span>{/if}
  {#each issue.actions as action (action.label)}
    {#if action.kind === 'link'}
      <a class='btn secondary sm' href={action.href} onclick={event => follow(event, action)}>{action.label}</a>
    {:else if action.kind === 'refresh'}
      <!-- Same availability rules as the rail button (spec §2.4): a blocked click is a no-op and keeps the popover open. -->
      <ReasonButton class='ghost sm' reason={metadataUnavailableReason()} busy={app.busy.metadata} onclick={() => run(action)}>{action.label}</ReasonButton>
    {:else}
      <button type='button' class='btn ghost sm' onclick={() => run(action)}>{action.label}</button>
    {/if}
  {/each}
</li>
