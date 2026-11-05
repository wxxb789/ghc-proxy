import type { BehaviorResponse } from '@contract'
import { compactJson, formatNumber, plural } from '../../lib/format.ts'

/**
 * One Behavior kv row (spec §5.5). `value` is text, or lines / a strategy chain;
 * an empty list renders `none`. `muted` marks the spec §4.3 off-state words (`disabled`, `no`, `rejected`)
 * in --text-3; `forwarded` and `filtered` stay --text-1.
 */
export interface KvRow {
  label: string
  value: string | string[]
  mono?: boolean
  muted?: boolean
  chain?: boolean
  title?: string
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
    ...([['Messages strategies', messages], ['Responses strategies', responses], ['Chat Completions strategies', chatCompletions]] as const)
      .map(([label, list]) => raw ? { label, value: list.join(' -> '), mono: true } : { label, value: [...list], chain: true }),
  ]
}

export function parameterRows(data: BehaviorResponse, raw: boolean): KvRow[] {
  const { responsesFilters, responsesFiltersReplaceDefault, responsesOutputTokenFloor, chatMaxCompletionTokenModels } = data.parameterHandling
  const context = data.contextManagement
  const tools = data.toolCompatibility
  return [
    { label: 'Native Responses filters', ...json(raw, responsesFilters, { value: arrows(responsesFilters.map(filter => [filter.models.join(', '), filter.params.join(', ')])), mono: true }) },
    { label: 'Replace defaults', ...flag(responsesFiltersReplaceDefault, 'yes', 'no') },
    { label: 'Native output token floor', value: formatNumber(responsesOutputTokenFloor) },
    {
      label: 'Native context management',
      ...json(raw, context, {
        value: `${context.enabled ? 'enabled' : 'disabled'} · auto-compact ${context.autoCompactInput ? 'on' : 'off'} · threshold ${context.defaultCompactThreshold} · ${plural(context.models.length, 'model')}`,
        title: context.models.join(', '),
        muted: !context.enabled,
      }),
    },
    { label: 'Function apply_patch', ...flag(tools.functionApplyPatch, 'enabled', 'disabled') },
    { label: 'Responses via Chat', ...flag(tools.responsesChatCompletionsFallback, 'enabled', 'disabled') },
    { label: 'Native remote image URLs', ...flag(!tools.remoteResponsesImageUrlsRejected, 'forwarded', 'rejected') },
    { label: 'max_completion_tokens models', value: chatMaxCompletionTokenModels.length ? chatMaxCompletionTokenModels.join(', ') : [], mono: true },
    { label: 'Unresolvable Responses items', value: tools.unresolvableResponsesItemsFiltered ? 'filtered' : 'forwarded' },
  ]
}
