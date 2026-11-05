<script lang='ts'>
  import { announcer } from '../lib/store.svelte.ts'
</script>

<div class='sr-only' role='status' aria-live='polite'>{announcer.text}</div>
