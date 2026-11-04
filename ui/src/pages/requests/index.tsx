import type { DashboardRequest, DashboardRequests } from '@contract'
import { useEffect, useRef } from 'react'
import { Link } from 'wouter'
import { useDashboardUrl } from '../../app/context'
import { Card, DataTable, Region, StatusChip } from '../../components/primitives'
import { formatDateTime, formatDuration, formatInteger } from '../../lib/format'
import { useRequests } from '../../lib/queries'
import { buildUrl, REQUEST_STATES } from '../../lib/url-state'
import '../../components/charts/monitor.css'

const STATE_LABELS = { in_flight: 'In flight', streaming: 'Streaming', completed: 'Completed', failed: 'Failed', aborted: 'Aborted' } as const

function RequestDetail({ request }: { request: DashboardRequest }) {
  return (
    <div className="stack">
      <section aria-label="Lifecycle">
        <h3 className="monitor-detail-title">Lifecycle</h3>
        <dl className="monitor-facts">
          <div>
            <dt>Request identifier</dt>
            <dd aria-label="Request identifier">{request.requestId}</dd>
          </div>
          <div>
            <dt>State</dt>
            <dd><StatusChip state={request.state} /></dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd>{request.accountName ?? 'Not specified'}</dd>
          </div>
          <div>
            <dt>Endpoint</dt>
            <dd>
              {request.method}
              {' '}
              {request.endpoint}
            </dd>
          </div>
          <div>
            <dt>Started</dt>
            <dd>{formatDateTime(request.startedAt)}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>
              {formatDuration(request.durationMs)}
              {request.state === 'in_flight' || request.state === 'streaming' ? ' · in progress' : ''}
            </dd>
          </div>
          <div>
            <dt>HTTP status</dt>
            <dd>{request.status ?? 'Not received'}</dd>
          </div>
        </dl>
      </section>
      <section aria-label="Transform trace">
        <h3 className="monitor-detail-title">Transform trace</h3>
        <dl className="monitor-facts">
          <div>
            <dt>Requested model</dt>
            <dd>{request.requestedModel ?? 'Not specified'}</dd>
          </div>
          <div>
            <dt>Effective model</dt>
            <dd>{request.effectiveModel ?? 'Not resolved'}</dd>
          </div>
        </dl>
        {request.modelTransforms.length === 0
          ? <p className="muted">No model transformations recorded.</p>
          : (
              <ol className="monitor-trace">
                {request.modelTransforms.map((transform, index) => (
                  <li key={`${index}:${transform.tag}`}>
                    <strong>{transform.tag}</strong>
                    :
                    {' '}
                    <code>{transform.from}</code>
                    {' '}
                    →
                    {' '}
                    <code>{transform.to}</code>
                  </li>
                ))}
              </ol>
            )}
      </section>
      <section aria-label="Strategy">
        <h3 className="monitor-detail-title">Strategy</h3>
        <p>{request.selectedStrategy ?? 'No strategy selected yet.'}</p>
      </section>
      <section aria-label="Effects">
        <h3 className="monitor-detail-title">Effects</h3>
        {request.effects.length === 0
          ? <p className="muted">No effects recorded.</p>
          : (
              <DataTable
                caption="Request effects"
                rows={request.effects}
                rowKey={effect => effect.id}
                columns={[
                  { key: 'effect', header: 'Effect', render: effect => effect.id },
                  { key: 'count', header: 'Count', render: effect => formatInteger(effect.count), numeric: true },
                ]}
              />
            )}
      </section>
      <section aria-label="Error summary">
        <h3 className="monitor-detail-title">Error summary</h3>
        <p>{request.errorSummary ?? (request.state === 'failed' ? `Request failed${request.status === undefined ? '.' : ` with HTTP ${request.status}.`}` : 'No error recorded.')}</p>
      </section>
    </div>
  )
}

function RequestList({ data }: { data: DashboardRequests }) {
  const { url, navigate } = useDashboardUrl()
  const all = [...data.active, ...data.recent]
  const targetRows = all.filter(request => url.target === undefined || request.accountName === url.target)
  const rows = targetRows.filter(request => (url.state === undefined || request.state === url.state)
    && (url.endpoint === undefined || request.endpoint === url.endpoint)
    && (url.model === undefined || request.requestedModel === url.model || request.effectiveModel === url.model))
  const endpoints = [...new Set([...all.map(request => request.endpoint), ...(url.endpoint === undefined ? [] : [url.endpoint])])].sort()
  const models = [...new Set([...all.flatMap(request => [request.requestedModel, request.effectiveModel]).filter((model): model is string => model !== undefined), ...(url.model === undefined ? [] : [url.model])])].sort()
  const states: readonly string[] = url.state !== undefined && !Object.hasOwn(STATE_LABELS, url.state) ? [...REQUEST_STATES, url.state] : REQUEST_STATES
  const retainedTerminal = targetRows.filter(request => request.state !== 'in_flight' && request.state !== 'streaming')
  const noTraffic = all.length === 0 && data.totals.started === 0
  let empty = 'No requests match these filters.'
  if (noTraffic)
    empty = 'No traffic yet. Requests will appear here as they start.'
  else if (url.state === 'failed' && !targetRows.some(request => request.state === 'failed'))
    empty = 'Zero failures in the retained requests for this target scope. Older failures may no longer be listed; the ring keeps only the last 256 terminal requests.'
  else if (all.length === 0)
    empty = 'No requests are retained. The request ring keeps active requests and the last 256 terminal requests, not persistent history.'
  return (
    <>
      <div className="inline-controls monitor-request-filters">
        <label className="form-field">
          Request state
          <select value={url.state === undefined ? '' : JSON.stringify(url.state)} onChange={event => navigate({ state: event.target.value === '' ? undefined : JSON.parse(event.target.value) as string })}>
            <option value="">All states</option>
            {states.map(state => <option key={state} value={JSON.stringify(state)}>{Object.hasOwn(STATE_LABELS, state) ? STATE_LABELS[state as keyof typeof STATE_LABELS] : state}</option>)}
          </select>
        </label>
        <label className="form-field">
          Endpoint
          <select value={url.endpoint === undefined ? '' : JSON.stringify(url.endpoint)} onChange={event => navigate({ endpoint: event.target.value === '' ? undefined : JSON.parse(event.target.value) as string })}>
            <option value="">All endpoints</option>
            {endpoints.map(endpoint => <option key={endpoint} value={JSON.stringify(endpoint)}>{endpoint}</option>)}
          </select>
        </label>
        <label className="form-field">
          Model
          <select value={url.model === undefined ? '' : JSON.stringify(url.model)} onChange={event => navigate({ model: event.target.value === '' ? undefined : JSON.parse(event.target.value) as string })}>
            <option value="">All models</option>
            {models.map(model => <option key={model} value={JSON.stringify(model)}>{model}</option>)}
          </select>
        </label>
      </div>
      <dl className="monitor-kpis">
        <div>
          <dt>Active requests</dt>
          <dd>{formatInteger(targetRows.length - retainedTerminal.length)}</dd>
          <small>Includes streaming</small>
        </div>
        <div>
          <dt>Retained terminal requests</dt>
          <dd aria-label="Retained terminal requests">{formatInteger(retainedTerminal.length)}</dd>
          <small>
            {retainedTerminal.filter(request => request.state === 'completed').length}
            {' '}
            completed ·
            {' '}
            {retainedTerminal.filter(request => request.state === 'failed').length}
            {' '}
            failed ·
            {' '}
            <span aria-label="Retained aborted requests">{retainedTerminal.filter(request => request.state === 'aborted').length}</span>
            {' '}
            aborted
          </small>
        </div>
      </dl>
      <p className="muted monitor-detail-title">
        {formatInteger(rows.length)}
        {' '}
        matching rows. Active requests plus the last
        {' '}
        {formatInteger(data.capacity)}
        {' '}
        terminal requests across targets are retained in memory. Filters do not change a selected request.
      </p>
      <DataTable
        caption="Requests"
        rows={rows}
        rowKey={request => request.requestId}
        empty={empty}
        columns={[
          { key: 'id', header: 'Request', render: request => <Link className="monitor-request-link" aria-current={url.request === request.requestId ? 'true' : undefined} href={buildUrl({ ...url, request: request.requestId })}>{request.requestId}</Link> },
          { key: 'state', header: 'State', render: request => <StatusChip state={request.state} /> },
          { key: 'target', header: 'Target', render: request => request.accountName ?? 'Not specified' },
          { key: 'endpoint', header: 'Endpoint', render: request => `${request.method} ${request.endpoint}` },
          { key: 'model', header: 'Model', render: request => request.effectiveModel ?? request.requestedModel ?? 'Not specified' },
          { key: 'strategy', header: 'Strategy', render: request => request.selectedStrategy ?? 'Not selected' },
          { key: 'status', header: 'HTTP status', render: request => request.status ?? '—', numeric: true },
          { key: 'duration', header: 'Duration', render: request => formatDuration(request.durationMs), numeric: true },
          { key: 'started', header: 'Started', render: request => formatDateTime(request.startedAt) },
        ]}
      />
      <details className="chart-table">
        <summary>Since-startup totals (all targets, not the selected window)</summary>
        <dl className="monitor-facts">
          <div>
            <dt>Terminal requests including aborted</dt>
            <dd aria-label="Since-startup terminal requests">{formatInteger(data.totals.completed + data.totals.aborted)}</dd>
          </div>
          <div>
            <dt>Successful requests</dt>
            <dd>{formatInteger(data.totals.completed - data.totals.failed)}</dd>
          </div>
          <div>
            <dt>Failed requests</dt>
            <dd>{formatInteger(data.totals.failed)}</dd>
          </div>
          <div>
            <dt>Aborted requests</dt>
            <dd aria-label="Since-startup aborted requests">{formatInteger(data.totals.aborted)}</dd>
          </div>
        </dl>
      </details>
    </>
  )
}

export function RequestsPage() {
  const { url } = useDashboardUrl()
  const requests = useRequests()
  const detailRef = useRef<HTMLDivElement>(null)
  const hasData = requests.data !== undefined
  useEffect(() => {
    if (url.request === undefined || !hasData)
      return
    let current = true
    queueMicrotask(() => {
      if (current)
        detailRef.current?.focus()
    })
    return () => {
      current = false
    }
  }, [url.request, hasData])
  const selected = url.request === undefined
    ? undefined
    : requests.data?.active.find(request => request.requestId === url.request) ?? requests.data?.recent.find(request => request.requestId === url.request)
  let detail
  if (url.request === undefined) {
    detail = <p className="muted">Select a request to inspect its lifecycle and routing decisions.</p>
  }
  else if (selected) {
    detail = <RequestDetail request={selected} />
  }
  else if (requests.data) {
    detail = (
      <p>
        This request is not retained:
        {' '}
        <strong>{url.request}</strong>
        . The URL has been kept. Only active requests and the last
        {' '}
        {requests.data.capacity}
        {' '}
        terminal requests are available; older failures may no longer be listed.
      </p>
    )
  }
  else {
    detail = <p>{requests.region.state === 'loading' ? 'Loading the selected request…' : 'The selected request cannot be checked until request data is available. The URL has been kept.'}</p>
  }
  return (
    <div className={url.request === undefined ? 'monitor-request-layout' : 'monitor-request-layout has-selection'}>
      <Region title="Request activity" result={{ ...requests.region, state: requests.region.state === 'empty' ? 'ready' : requests.region.state }} retry={() => { void requests.refetch() }}>
        {data => <RequestList data={data} />}
      </Region>
      <Card title="Request detail">
        <div ref={detailRef} className="monitor-request-detail" role="group" aria-label="Selected request detail" tabIndex={-1}>
          {detail}
        </div>
      </Card>
    </div>
  )
}
