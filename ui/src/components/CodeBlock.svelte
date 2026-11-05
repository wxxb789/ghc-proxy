<script lang='ts'>
  import type { StatusLine } from '../lib/account-actions.svelte.ts'
  import { copyInto } from '../lib/clipboard.ts'
  import Icon from './Icon.svelte'
  import StatusText from './StatusText.svelte'

  interface Props {
    text: string
    /** What the block holds, e.g. `request JSON`; names the pre and the Copy button. */
    label: string
    id?: string
    /** Caps the height at 360 px (JSON). */
    tall?: boolean
  }

  const { text, label, id, tall = false }: Props = $props()
  const status = $state<StatusLine>({ text: '', tone: '' })
  let copied = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  async function copy() {
    if (!await copyInto(status, text))
      return
    copied = true
    clearTimeout(timer)
    timer = setTimeout(() => copied = false, 1500)
  }

  $effect(() => () => clearTimeout(timer))
</script>

<div class='code'>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (scrollable code must be keyboard-reachable, spec §4.16) -->
  <pre {id} class={{ tall }} tabindex='0' aria-label={label}>{text}</pre>
  <button type='button' class='btn ghost icon-btn code-copy' aria-label='Copy {label}' onclick={copy}><Icon name={copied ? 'check' : 'copy'} /></button>
  <StatusText line={status} />
</div>
