import type { BehaviorResult } from '../../lib/api'
import { useDashboardUrl } from '../../app/context'
import { Card, DataTable, Region } from '../../components/primitives'
import { formatDateTime, formatInteger, formatPercent } from '../../lib/format'
import { useBehavior } from '../../lib/queries'
import './behavior.css'

function BehaviorConfiguration({ data }: { data: BehaviorResult }) {
  const routing = data.modelRouting
  const parameters = data.parameterHandling
  const context = data.contextManagement
  const tools = data.toolCompatibility
  return (
    <div className="stack">
      <p className="muted">{`Host target: ${data.hostTarget}`}</p>
      <p className="muted">Current configuration applies to this host target. Effect counts are process-wide; the Monitor target filter does not change this view.</p>
      <div className="grid-cards">
        <Card title="Model routing">
          <dl className="behavior-values">
            <div>
              <dt>Auto-correct model names</dt>
              <dd>{routing.autoCorrect.enabled ? 'Enabled' : 'Waiting for models'}</dd>
            </div>
            <div>
              <dt>Compact model routing</dt>
              <dd>
                {routing.compact.enabled ? 'Enabled' : 'Disabled'}
                {routing.compact.smallModel && ` · ${routing.compact.smallModel}`}
              </dd>
            </div>
            <div>
              <dt>Claude Opus fallback</dt>
              <dd>{routing.familyFallbacks.claudeOpus}</dd>
            </div>
            <div>
              <dt>Claude Sonnet fallback</dt>
              <dd>{routing.familyFallbacks.claudeSonnet}</dd>
            </div>
            <div>
              <dt>Claude Haiku fallback</dt>
              <dd>{routing.familyFallbacks.claudeHaiku}</dd>
            </div>
          </dl>
          <DataTable caption="Model rewrite rules" rows={routing.rewrites} rowKey={row => row.from} columns={[{ key: 'from', header: 'Requested model', render: row => <code>{row.from}</code> }, { key: 'to', header: 'Rewritten model', render: row => <code>{row.to}</code> }]} empty="No model rewrite rules." />
          <DataTable caption="Overload fallbacks" rows={Object.entries(routing.overloadFallbacks)} rowKey={row => row[0]} columns={[{ key: 'from', header: 'Overloaded model', render: row => <code>{row[0]}</code> }, { key: 'to', header: 'Fallback model', render: row => <code>{row[1]}</code> }]} empty="No overload fallbacks." />
        </Card>
        <Card title="Execution strategies">
          <dl className="behavior-values">
            <div>
              <dt>Messages</dt>
              <dd>{data.strategies.messages.join(' → ') || 'None'}</dd>
            </div>
            <div>
              <dt>Responses</dt>
              <dd>{data.strategies.responses.join(' → ') || 'None'}</dd>
            </div>
            <div>
              <dt>Chat Completions</dt>
              <dd>{data.strategies.chatCompletions.join(' → ') || 'None'}</dd>
            </div>
          </dl>
        </Card>
      </div>
      <Card title="Parameter handling">
        <dl className="behavior-values">
          <div>
            <dt>Responses filter mode</dt>
            <dd>{parameters.responsesFiltersReplaceDefault ? 'Replace defaults' : 'Extend defaults'}</dd>
          </div>
          <div>
            <dt>Responses output token floor</dt>
            <dd>{formatInteger(parameters.responsesOutputTokenFloor)}</dd>
          </div>
          <div>
            <dt>Chat max_completion_tokens models</dt>
            <dd>{parameters.chatMaxCompletionTokenModels.join(', ') || 'None'}</dd>
          </div>
        </dl>
        <DataTable caption="Responses parameter filters" rows={parameters.responsesFilters} rowKey={row => row.models.join(',')} columns={[{ key: 'models', header: 'Models', render: row => row.models.join(', ') || 'All models' }, { key: 'parameters', header: 'Filtered parameters', render: row => row.params.join(', ') || 'None' }]} empty="No Responses parameter filters configured." />
      </Card>
      <div className="grid-cards">
        <Card title="Context management">
          <dl className="behavior-values">
            <div>
              <dt>Context management</dt>
              <dd>{context.enabled ? 'Enabled' : 'Disabled'}</dd>
            </div>
            <div>
              <dt>Managed models</dt>
              <dd>{context.models.join(', ') || 'None explicitly configured'}</dd>
            </div>
            <div>
              <dt>Auto-compact input</dt>
              <dd>{context.autoCompactInput ? 'Enabled' : 'Disabled'}</dd>
            </div>
            <div>
              <dt>Default compact threshold</dt>
              <dd>{formatPercent(context.defaultCompactThreshold)}</dd>
            </div>
          </dl>
        </Card>
        <Card title="Tool compatibility">
          <dl className="behavior-values">
            <div>
              <dt>Responses via Chat Completions fallback</dt>
              <dd>{tools.responsesChatCompletionsFallback ? 'Enabled' : 'Disabled'}</dd>
            </div>
            <div>
              <dt>Function apply_patch</dt>
              <dd>{tools.functionApplyPatch ? 'Enabled' : 'Disabled'}</dd>
            </div>
            <div>
              <dt>Remote Responses image URLs</dt>
              <dd>{tools.remoteResponsesImageUrlsRejected ? 'Rejected' : 'Not rejected'}</dd>
            </div>
            <div>
              <dt>Unresolvable Responses items</dt>
              <dd>{tools.unresolvableResponsesItemsFiltered ? 'Filtered' : 'Not filtered'}</dd>
            </div>
          </dl>
        </Card>
      </div>
      <Card title="Observed effects" description={`Window collection began ${formatDateTime(data.collectionStartedAt)}. Cumulative totals count effects since this proxy process started.`}>
        <DataTable
          caption="Observed behavior effects"
          rows={data.effects.toSorted((left, right) => right.count - left.count || left.category.localeCompare(right.category) || left.label.localeCompare(right.label))}
          rowKey={row => row.id}
          columns={[
            { key: 'label', header: 'Effect', render: row => row.label },
            { key: 'category', header: 'Category', render: row => row.category },
            { key: 'window', header: `Last ${data.window}`, render: row => formatInteger(row.windowCount), numeric: true },
            { key: 'total', header: 'Since process start', render: row => formatInteger(row.count), numeric: true },
          ]}
          empty="No effects have been recorded."
        />
      </Card>
    </div>
  )
}

export function BehaviorPage() {
  const { url } = useDashboardUrl()
  const behavior = useBehavior(url.window)
  return (
    <Region plain title="Proxy behavior" result={behavior.region} retry={() => { void behavior.refetch() }}>{data => <BehaviorConfiguration data={data} />}</Region>
  )
}
