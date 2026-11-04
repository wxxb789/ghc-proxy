import type { DashboardModel } from '@contract'
import type { ModelsResult } from '../../lib/api'
import { useEffect, useState } from 'react'
import { useDashboard } from '../../app/context'
import { Region } from '../../components/primitives'
import { copyText } from '../../lib/format'
import { useModels } from '../../lib/queries'
import { modelCapabilities, modelCompatibility, modelLimits, selectedModelsTsv } from './projection'
import './models.css'

function ModelCatalog({ data }: { data: ModelsResult }) {
  const { announce } = useDashboard()
  const [filter, setFilter] = useState('')
  const [grouped, setGrouped] = useState(true)
  const [sort, setSort] = useState('asc')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [message, setMessage] = useState('')
  const [copying, setCopying] = useState(false)
  useEffect(() => {
    setSelected((previous) => {
      const available = new Set(data.models.map(model => model.id))
      return [...previous].every(id => available.has(id)) ? previous : new Set([...previous].filter(id => available.has(id)))
    })
  }, [data.models])
  const availableSelection = new Set(data.models.filter(model => selected.has(model.id)).map(model => model.id))
  const query = filter.trim().toLowerCase()
  const models = data.models.filter(model => !query || [model.id, model.name, model.vendor, model.effective.defaultMessagesStrategy].some(value => value.toLowerCase().includes(query)))
    .sort((left, right) => {
      if (grouped) {
        const vendor = (left.vendor || 'Unknown').localeCompare(right.vendor || 'Unknown')
        if (vendor !== 0)
          return vendor
      }
      return (sort === 'desc' ? -1 : 1) * (left.name || left.id).localeCompare(right.name || right.id)
    })
  const groups = new Map<string, DashboardModel[]>()
  for (const model of models) {
    const vendor = grouped ? model.vendor || 'Unknown' : ''
    const group = groups.get(vendor)
    if (group)
      group.push(model)
    else
      groups.set(vendor, [model])
  }
  function toggleSelection(id: string) {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id))
        next.delete(id)
      else
        next.add(id)
      return next
    })
    setMessage('')
  }
  async function copySelection() {
    setCopying(true)
    try {
      await copyText(selectedModelsTsv(data.models, availableSelection, data.apiBaseUrl))
      const result = `Copied ${availableSelection.size} model${availableSelection.size === 1 ? '' : 's'}.`
      setMessage(result)
      announce(result)
    }
    catch (error) {
      const result = error instanceof Error ? error.message : 'Copy failed.'
      setMessage(result)
      announce(result)
    }
    finally {
      setCopying(false)
    }
  }
  return (
    <div className="stack">
      <div>
        <p className="muted">{`Host target: ${data.hostTarget}`}</p>
        <p className="muted">
          API endpoint:
          {' '}
          <code>{data.apiBaseUrl}</code>
        </p>
      </div>
      <div className="inline-controls">
        <label className="form-field">
          Filter models
          <input type="text" value={filter} onChange={event => setFilter(event.target.value)} />
        </label>
        <label className="inline-controls">
          <input type="checkbox" checked={grouped} onChange={event => setGrouped(event.target.checked)} />
          Group by vendor
        </label>
        <label className="form-field">
          Sort models
          <select value={sort} onChange={event => setSort(event.target.value)}>
            <option value="asc">Name A–Z</option>
            <option value="desc">Name Z–A</option>
          </select>
        </label>
        <button type="button" disabled={availableSelection.size === 0 || copying} onClick={() => { void copySelection() }}>
          Copy selected (
          {availableSelection.size}
          )
        </button>
      </div>
      <p className="muted">
        {models.length}
        {' '}
        of
        {' '}
        {data.models.length}
        {' '}
        models · Select multiple rows to copy as TSV.
      </p>
      {message && <p>{message}</p>}
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Model list">
        <table className="models-table">
          <caption className="sr-only">Available models</caption>
          <thead>
            <tr>
              <th scope="col">Select</th>
              <th scope="col">Model</th>
              <th scope="col">Metadata</th>
              <th scope="col">Messages route</th>
              <th scope="col">Upstream endpoints</th>
              <th scope="col">Limits</th>
              <th scope="col">Capabilities</th>
              <th scope="col">Proxy compatibility</th>
            </tr>
          </thead>
          {Array.from(groups, ([vendor, group]) => (
            <tbody key={vendor}>
              {grouped && <tr><th colSpan={8} scope="rowgroup">{vendor}</th></tr>}
              {group.map(model => (
                <tr
                  key={model.id}
                  className={availableSelection.has(model.id) ? 'model-selected' : undefined}
                  tabIndex={0}
                  onClick={() => toggleSelection(model.id)}
                  onKeyDown={(event) => {
                    if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault()
                      toggleSelection(model.id)
                    }
                  }}
                >
                  <td><input type="checkbox" aria-label={`Select ${model.id}`} checked={availableSelection.has(model.id)} onClick={event => event.stopPropagation()} onChange={() => toggleSelection(model.id)} /></td>
                  <td>
                    <strong><code>{model.id}</code></strong>
                    <p>
                      {model.name}
                      {model.preview ? ' / preview' : ''}
                    </p>
                    <p className="muted">{`Picker ${model.pickerEnabled ? 'enabled' : 'disabled'}`}</p>
                  </td>
                  <td>
                    <p>
                      {model.vendor || 'Unknown'}
                      {' '}
                      /
                      {' '}
                      {model.version || '—'}
                    </p>
                    {Object.entries(model.upstream.capabilities).filter(([key, value]) => typeof value === 'string' && key !== 'limits' && key !== 'supports').map(([key, value]) => (
                      <p key={key} className="muted">
                        {key}
                        :
                        {' '}
                        {String(value)}
                      </p>
                    ))}
                    {model.upstream.policy && (
                      <p className="muted">{`Policy: ${model.upstream.policy.state} · ${model.upstream.policy.terms}`}</p>
                    )}
                  </td>
                  <td><code>{model.effective.defaultMessagesStrategy}</code></td>
                  <td><code>{model.upstream.endpoints.join(', ') || '—'}</code></td>
                  <td className="model-lines">{modelLimits(model, '\n')}</td>
                  <td>
                    <p>{modelCapabilities(model)}</p>
                    <details onClick={event => event.stopPropagation()}>
                      <summary>Capability details</summary>
                      <dl className="model-details">
                        {Object.entries(model.upstream.capabilities.supports).map(([key, value]) => (
                          <div key={key}>
                            <dt>{key}</dt>
                            <dd>{Array.isArray(value) ? value.join(', ') || 'none' : value ? 'yes' : 'no'}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  </td>
                  <td>
                    <p className="model-lines">{modelCompatibility(model).join('\n')}</p>
                    <details onClick={event => event.stopPropagation()}>
                      <summary>Effective capabilities</summary>
                      <dl className="model-details">
                        <div>
                          <dt>Native Messages</dt>
                          <dd>{model.effective.nativeMessagesAvailable ? 'yes' : 'no'}</dd>
                        </div>
                        <div>
                          <dt>Responses available</dt>
                          <dd>{model.effective.responsesAvailable ? 'yes' : 'no'}</dd>
                        </div>
                        <div>
                          <dt>Native Responses</dt>
                          <dd>{model.effective.nativeResponsesAvailable ? 'yes' : 'no'}</dd>
                        </div>
                        <div>
                          <dt>Native structured output</dt>
                          <dd>{model.effective.nativeStructuredOutput ? 'yes' : 'no'}</dd>
                        </div>
                        <div>
                          <dt>Tool calls</dt>
                          <dd>{model.effective.toolCalls ? 'yes' : 'no'}</dd>
                        </div>
                        <div>
                          <dt>Vision</dt>
                          <dd>{model.effective.vision ? 'yes' : 'no'}</dd>
                        </div>
                        <div>
                          <dt>Adaptive thinking</dt>
                          <dd>{model.effective.adaptiveThinking ? 'yes' : 'no'}</dd>
                        </div>
                        <div>
                          <dt>Reasoning effort</dt>
                          <dd>{model.effective.reasoningEffort.join(', ') || 'none'}</dd>
                        </div>
                      </dl>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
          {models.length === 0 && <tbody><tr><td colSpan={8}>No matching models.</td></tr></tbody>}
        </table>
      </div>
    </div>
  )
}

export function ModelsPage() {
  const models = useModels()
  return (
    <Region title="Model catalog" result={models.region} retry={() => { void models.refetch() }} empty={models.data ? <ModelCatalog data={models.data} /> : undefined}>{data => <ModelCatalog data={data} />}</Region>
  )
}
