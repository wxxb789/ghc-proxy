<script lang='ts'>
  import type { ToneDomain, ToneKind } from '../lib/tone.ts'
  import { isLoud, statusText, toneOf } from '../lib/tone.ts'

  interface Props {
    /** Server value; status tags display it with `_` → space, lowercase as sent. */
    value: string
    /** Tone whitelist domain (spec §4.3); ignored when `tone` is given. */
    domain?: ToneDomain
    tone?: ToneKind
    /** status: quiet/loud by tone; outline: roles (`default`, `GitHub`); mono: strategies, endpoints, transform tags. */
    kind?: 'status' | 'outline' | 'mono'
  }

  const { value, domain, tone, kind = 'status' }: Props = $props()
  const resolved = $derived(tone ?? (domain ? toneOf(domain, value) : 'hollow'))
</script>

{#if kind === 'status'}
  <span class={['tag', isLoud(resolved) ? `tag-loud tone-${resolved}` : 'tag-quiet', resolved === 'none' && 'tag-none']}>{#if resolved !== 'none'}<span class='lamp lamp-{resolved}'></span>{/if}{statusText(value)}</span>
{:else}
  <span class='tag tag-{kind}'>{value}</span>
{/if}
