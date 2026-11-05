import type { BehaviorResponse } from '@contract'
import { compactJson, formatNumber } from '../../lib/format.ts'

/**
 * One Behavior kv row (spec §5.5). `value` is text, or lines / a strategy chain;
 * an empty list renders `none`. `muted` marks the spec §4.3 off-state words (`disabled`, `no`, `rejected`)
 * in --text-3; `forwarded` and `filtered` stay --text-1.
 */
export interface KvRow {
  /** Visible dt text. `srPrefix`/`srSuffix` complete the full label for AT where the group subhead already says it. */
  label: string
  srPrefix?: string
  srSuffix?: string
  /** Subhead of the `<dl>` block this row sits in; grouped rows are consecutive and follow the ungrouped ones. */
  group?: string
  value: string | string[]
  /** A keyed last line, e.g. `models gpt-5, o3`: muted key, mono items, `none` when empty. */
  list?: { key: string, items: string[] }
  mono?: boolean
  muted?: boolean
  chain?: boolean
}

const arrows = (pairs: Array<[string, string]>): string[] => pairs.map(([from, to]) => `${from} → ${to}`)
const flag = (on: boolean, yes: string, no: string) => ({ value: on ? yes : no, muted: !on })
/** Legacy rows show the exact `compactJson` string while Raw JSON is on. */
function json(raw: boolean, value: unknown, structured: Omit<KvRow, 'label'>): Omit<KvRow, 'label'> {
  return raw ? { value: compactJson(value), mono: true } : structured
}

export function routingRows(data: BehaviorResponse, raw: boolean): KvRow[] {
  const { rewrites, autoCorrect, compact, familyFallbacks: family, overloadFallbacks } = data.modelRouting
  const { messages, responses, chatCompletions } = data.strategies
  return [
    { label: 'Rewrites', ...json(raw, rewrites, { value: arrows(rewrites.map(rewrite => [rewrite.from, rewrite.to])), mono: true }) },
    { label: 'Auto-correct', ...flag(autoCorrect.enabled, 'enabled', 'waiting for models') },
    { label: 'Compact routing', ...json(raw, compact, { ...flag(compact.enabled, ['enabled', compact.smallModel].filter(Boolean).join(' · '), 'disabled'), mono: true }) },
    { label: 'Family fallbacks', ...json(raw, family, { value: arrows([['opus', family.claudeOpus], ['sonnet', family.claudeSonnet], ['haiku', family.claudeHaiku]]), mono: true }) },
    { label: 'Overload fallbacks', ...json(raw, overloadFallbacks, { value: arrows(Object.entries(overloadFallbacks)), mono: true }) },
    ...([['Messages', messages], ['Responses', responses], ['Chat Completions', chatCompletions]] as const)
      .map(([label, list]) => ({ label, srSuffix: ' strategies', group: 'Strategies', ...(raw ? { value: list.join(' -> '), mono: true } : { value: [...list], chain: true }) })),
  ]
}

export function parameterRows(data: BehaviorResponse, raw: boolean): KvRow[] {
  const { responsesFilters, responsesFiltersReplaceDefault, responsesOutputTokenFloor, chatMaxCompletionTokenModels } = data.parameterHandling
  const context = data.contextManagement
  const tools = data.toolCompatibility
  // Lowercase visible labels: the dt's first letter is capitalized in CSS so its text stays the full label.
  const native = (label: string, srPrefix = 'Native ') => ({ label, srPrefix, group: 'Native Responses' })
  return [
    { label: 'Function apply_patch', ...flag(tools.functionApplyPatch, 'enabled', 'disabled') },
    { label: 'Responses via Chat', ...flag(tools.responsesChatCompletionsFallback, 'enabled', 'disabled') },
    { label: 'max_completion_tokens models', value: chatMaxCompletionTokenModels.length ? chatMaxCompletionTokenModels.join(', ') : [], mono: true },
    { label: 'Unresolvable Responses items', value: tools.unresolvableResponsesItemsFiltered ? 'filtered' : 'forwarded' },
    { ...native('filters', 'Native Responses '), ...json(raw, responsesFilters, { value: arrows(responsesFilters.map(filter => [filter.models.join(', '), filter.params.join(', ')])), mono: true }) },
    { label: 'Replace defaults', group: 'Native Responses', ...flag(responsesFiltersReplaceDefault, 'yes', 'no') },
    { ...native('output token floor'), value: formatNumber(responsesOutputTokenFloor) },
    {
      ...native('context management'),
      ...json(raw, context, {
        value: [context.enabled ? 'enabled' : 'disabled', `auto-compact ${context.autoCompactInput ? 'on' : 'off'} · threshold ${context.defaultCompactThreshold}`],
        list: { key: 'models', items: context.models },
        muted: !context.enabled,
      }),
    },
    { ...native('remote image URLs'), ...flag(!tools.remoteResponsesImageUrlsRejected, 'forwarded', 'rejected') },
  ]
}
