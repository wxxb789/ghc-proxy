<script lang='ts'>
  import type { AccountAuthenticationSession } from '@contract'
  import type { StatusLine } from '../../lib/account-actions.svelte.ts'
  import Icon from '../../components/Icon.svelte'
  import StatusText from '../../components/StatusText.svelte'
  import Tag from '../../components/Tag.svelte'
  import { copyInto } from '../../lib/clipboard.ts'
  import { clock, useClock } from '../../lib/clock.svelte.ts'
  import { claimCardFocus, safeVerificationUri } from '../../lib/device-auth.svelte.ts'
  import { formatCountdown } from '../../lib/format.ts'

  // Only public authorization fields render; the device code never reaches the UI.
  // `live`: the flow still polls; after a poll error the last session stays visible but stops counting down.
  const { session, live }: { session: AccountAuthenticationSession, live: boolean } = $props()
  const link = $derived(safeVerificationUri(session.authorization.verificationUri))
  const pending = $derived(live && session.state === 'pending')
  // Visual only: polling and the form lock follow the server, not this countdown.
  const remaining = $derived(Date.parse(session.authorization.expiresAt) - clock.now)
  let copyButton = $state<HTMLButtonElement>()
  const copyStatus = $state<StatusLine>({ text: '', tone: '' })

  $effect(() => {
    if (pending)
      return useClock()
  })

  $effect(() => {
    if (copyButton && claimCardFocus(session.id))
      copyButton.focus()
  })

</script>

<section id='account-auth' class='device' aria-labelledby='account-auth-h'>
  <h3 id='account-auth-h'>Device code</h3>
  <ol class='steps stack'>
    <li>
      <span class='row'>
        <code class='user-code'>{session.authorization.userCode}</code>
        <button bind:this={copyButton} type='button' class='btn secondary sm' onclick={() => copyInto(copyStatus, session.authorization.userCode)}><Icon name='copy' />Copy code</button>
      </span>
      <StatusText line={copyStatus} />
    </li>
    {#if link}
      <li><a class='btn secondary' href={link} target='_blank' rel='noreferrer'><Icon name='external' />Open GitHub device login<span class='sr-only'> (opens in new tab)</span></a></li>
    {/if}
    <li>
      Approve in GitHub, then return here.
      <span class='row'><Tag value={session.state} domain='deviceAuth' />{#if session.message}<span class='text-2'>{session.message}</span>{/if}</span>
      {#if pending}
        {#if remaining > 0}
          <span class='meta line'>Code expires in {formatCountdown(remaining)}</span>
        {:else}
          <span class='meta line expired'>Code expired. If GitHub didn't accept it, start again once this attempt ends.</span>
        {/if}
      {/if}
    </li>
  </ol>
</section>

<style>
  .device { display: grid; gap: var(--s-3); padding: var(--s-4); border: 1px solid var(--line); border-radius: var(--r-3); background: var(--bg-0); }
  .expired { color: var(--warn-fg); }
  .user-code { font: 600 28px/32px var(--font-mono); letter-spacing: .12em; color: var(--text-1); }
  @media (max-width: 560px) {
    .user-code { font-size: 24px; line-height: 28px; }
  }
</style>
