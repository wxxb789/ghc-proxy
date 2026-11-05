<script lang='ts'>
  import type { ThemePref } from '../lib/store.svelte.ts'
  import Segmented from '../components/Segmented.svelte'
  import { app } from '../lib/store.svelte.ts'
  import { setThemePref } from '../lib/theme.ts'

  const OPTIONS: Array<{ value: ThemePref, label: string }> = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ]

  function change(pref: ThemePref) {
    app.prefs.theme = pref
    setThemePref(pref)
  }
</script>

<Segmented label='Theme' class='full' options={OPTIONS} value={app.prefs.theme} onchange={change} />
