<script lang='ts' module>
  export type IconName = 'mark' | 'overview' | 'requests' | 'accounts' | 'models' | 'behavior' | 'refresh' | 'copy' | 'check'
    | 'x' | 'triangle' | 'external' | 'chevron' | 'menu' | 'monitor' | 'sun' | 'moon' | 'keyboard'
</script>

<script lang='ts'>
  // Sprite reference: the <symbol>s live in ui/index.html (outside the JS budget).
  const { name, class: className }: { name: IconName, class?: string } = $props()
</script>

<svg class={['icon', className]} aria-hidden='true'><use href='#i-{name}' /></svg>
