import type { Attachment } from 'svelte/attachments'

/**
 * One-way value for a single `<select>`; pair it with an `onchange` writer.
 * Used instead of `bind:value` / `value=`, whose select-binding runtime costs
 * ~0.6 kB gzip. Pass the option list so the value is re-applied after the
 * options change (the attachment re-runs after the options render).
 */
export function selectValue(value: string, options: readonly unknown[] = []): Attachment<HTMLSelectElement> {
  return (select) => {
    void options.length
    select.value = value
  }
}
