<script lang='ts'>
  import type { StatusLine } from '../lib/account-actions.svelte.ts'

  // Inline status line (spec §4.9): persists until the control's next action.
  const { id, line }: { id?: string, line: StatusLine } = $props()
</script>

<p {id} class={['status-line', line.tone && `is-${line.tone}`]} role='status'>{line.text}</p>
