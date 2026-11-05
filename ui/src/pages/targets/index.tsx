import type { DashboardTarget } from '@contract'
import type { AddAccountBody, TargetsResult } from '../../lib/api'
import { useState } from 'react'
import { useDashboard, useDashboardUrl } from '../../app/context'
import { ConfirmDialog } from '../../components/dialog'
import { Card, DataTable, Region, StatusChip } from '../../components/primitives'
import { formatDateTime } from '../../lib/format'
import { useDashboardMutation } from '../../lib/mutations'
import { useTargets } from '../../lib/queries'
import { ClientSnippet } from './client-snippet'
import { M365Panel } from './m365-panel'
import './targets.css'

function TargetsConfiguration({ data }: { data: TargetsResult }) {
  const { authentication, trackAuthentication } = useDashboard()
  const { goToHostname } = useDashboardUrl()
  const [accountName, setAccountName] = useState('')
  const [hostname, setHostname] = useState('')
  const [tenant, setTenant] = useState('')
  const [bootstrapHostname, setBootstrapHostname] = useState<string>()
  const [removing, setRemoving] = useState<DashboardTarget | null>(null)
  const [outcome, setOutcome] = useState('')
  const add = useDashboardMutation({
    domains: ['targets', 'overview', 'models'],
    mutation: (api, body: AddAccountBody) => api.addAccount(body),
    successMessage: 'GitHub authorization started.',
    onSuccess: (result) => { trackAuthentication(result.authentication) },
  })
  const bootstrap = useDashboardMutation({
    domains: ['targets', 'overview', 'models', 'm365', 'behavior'],
    mutation: (api, hostname: string) => api.bootstrap({ hostname }),
    successMessage: 'Named routing enabled. Redirecting to the base hostname.',
    onSuccess: async (result) => { await goToHostname(result.baseHostname) },
  })
  const setDefault = useDashboardMutation({
    domains: ['targets', 'overview', 'models', 'm365', 'behavior'],
    mutation: (api, accountName: string) => api.setDefault({ accountName }),
    successMessage: 'Default target updated.',
    onSuccess: () => { setOutcome('Default target updated.') },
  })
  const removal = useDashboardMutation({
    domains: ['targets', 'overview', 'models', 'm365', 'behavior', 'quota'],
    mutation: async (api, target: DashboardTarget) => target.kind === 'm365' ? api.removeM365() : api.removeAccount(target.name),
    successMessage: 'Target removed.',
    onSuccess: async (result, target) => {
      setOutcome(`Removed ${target.name}.`)
      setRemoving(null)
      if (window.location.hostname.toLowerCase() === target.hostname.toLowerCase())
        await goToHostname('baseHostname' in result ? result.baseHostname : data.routing.baseHostname)
    },
  })
  const busy = add.isPending || bootstrap.isPending || setDefault.isPending || removal.isPending
  const bootstrapValue = bootstrapHostname ?? data.targets.find(target => target.isDefault)?.hostname ?? `default-account.${data.routing.baseHostname}`
  function requestRemoval(target: DashboardTarget) {
    removal.reset()
    setRemoving(target)
  }
  return (
    <>
      <Card title="Routing" description="Hostnames select route targets. Configure pages always show this process, independent of the Monitor target filter.">
        <dl className="target-values">
          <div>
            <dt>Host target</dt>
            <dd>{data.hostTarget}</dd>
          </div>
          <div>
            <dt>Base hostname</dt>
            <dd><code>{data.routing.baseHostname}</code></dd>
          </div>
          <div>
            <dt>Default target</dt>
            <dd>{data.routing.defaultAccount}</dd>
          </div>
          <div>
            <dt>Named routing</dt>
            <dd>{data.routing.routingEnabled ? 'Enabled' : 'Not enabled'}</dd>
          </div>
        </dl>
        {!data.capabilities.canAddAccount && !data.capabilities.canBootstrap && <p className="muted">Named-account management is unavailable for this process. The implicit target is read-only.</p>}
        {outcome && <p>{outcome}</p>}
        {setDefault.isPending && <p>Updating default target…</p>}
        {setDefault.error && <p className="form-error">{setDefault.error.message}</p>}
      </Card>
      <Card title="Route targets">
        <div className="target-table">
          <DataTable
            caption="Route targets"
            rows={data.targets}
            rowKey={target => target.runtimeId}
            empty="No targets are registered."
            columns={[
              { key: 'name', header: 'Target', render: target => (
                <div className="target-identity">
                  <span className="target-avatar" aria-hidden="true">{target.name.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <strong>{target.name}</strong>
                    <p className="muted">
                      {target.kind === 'github' ? 'GitHub' : 'M365'}
                      {target.isDefault ? ' · Default' : ''}
                    </p>
                  </div>
                </div>
              ) },
              { key: 'identity', header: 'Identity', render: target => (
                <>
                  <p>{target.identity ?? target.health.github.login ?? 'Identity unavailable'}</p>
                  <p className="muted">{target.tenant}</p>
                </>
              ) },
              { key: 'hostname', header: 'Hostname', render: target => <code>{target.hostname}</code> },
              { key: 'health', header: 'Health', render: target => (
                <div className="stack">
                  <StatusChip state={target.health.status} />
                  <p className="muted">
                    {`GitHub: ${target.health.github.status === 'not_applicable' ? 'Not applicable' : target.health.github.status}`}
                    <br />
                    {`Copilot: ${target.health.copilot.status}`}
                    <br />
                    {`Models: ${target.health.copilot.modelsLoaded ? 'Loaded' : 'Not loaded'}`}
                  </p>
                  {target.health.copilot.lastRefreshSucceeded === false && <p className="form-error">Last metadata refresh failed.</p>}
                </div>
              ) },
              { key: 'actions', header: 'Actions', render: target => (
                <div className="inline-controls">
                  {target.actions.canSetDefault && (
                    <button type="button" disabled={busy} onClick={() => setDefault.mutate(target.name)}>
                      {`Set ${target.name} as default`}
                    </button>
                  )}
                  {target.actions.canRemove && (
                    <button type="button" className="button-danger" disabled={busy} onClick={() => requestRemoval(target)}>
                      {`Remove ${target.name}`}
                    </button>
                  )}
                  {!target.actions.canSetDefault && !target.actions.canRemove && <span className="muted">{target.isDefault ? 'Default target' : 'Read-only'}</span>}
                </div>
              ) },
            ]}
          />
        </div>
        <div className="stack">{data.targets.map(target => <ClientSnippet key={target.runtimeId} target={target} />)}</div>
      </Card>
      {data.capabilities.canBootstrap && (
        <Card title="Enable named routing" description="Choose the default account hostname before enabling named-account routing. You can change this hostname before enabling.">
          <form
            className="inline-controls"
            onSubmit={(event) => {
              event.preventDefault()
              bootstrap.mutate(bootstrapValue)
            }}
          >
            <label className="form-field">
              Default account hostname
              <input required value={bootstrapValue} onChange={event => setBootstrapHostname(event.target.value)} disabled={busy} />
            </label>
            <button type="submit" disabled={busy}>Enable named routing</button>
          </form>
          {bootstrap.isPending && <p>Enabling named-account routing…</p>}
          {bootstrap.error && <p className="form-error">{bootstrap.error.message}</p>}
        </Card>
      )}
      {data.capabilities.canAddAccount && (
        <Card title="Add GitHub account" description="Connect a GitHub or GitHub Enterprise account with device authorization.">
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault()
              add.mutate({ accountName, hostname, ...(tenant.trim() ? { gheDomain: tenant.trim() } : {}) })
            }}
          >
            <div className="grid-cards">
              <label className="form-field">
                Account name
                <input required value={accountName} onChange={event => setAccountName(event.target.value)} disabled={busy || authentication?.state === 'pending'} autoComplete="off" />
              </label>
              <label className="form-field">
                GitHub hostname
                <input required value={hostname} onChange={event => setHostname(event.target.value)} disabled={busy || authentication?.state === 'pending'} autoComplete="off" />
              </label>
              <label className="form-field">
                GitHub Enterprise tenant (optional)
                <input value={tenant} onChange={event => setTenant(event.target.value)} disabled={busy || authentication?.state === 'pending'} placeholder="github.example.com" autoComplete="off" />
              </label>
            </div>
            <div><button type="submit" disabled={busy || authentication?.state === 'pending'}>Add GitHub account</button></div>
          </form>
          {add.isPending && <p>Starting GitHub authorization…</p>}
          {add.error && <p className="form-error">{add.error.message}</p>}
        </Card>
      )}
      {authentication && (
        <Card title="GitHub authorization">
          <div className="stack">
            <p>
              {`Account ${authentication.accountName} · `}
              <code>{authentication.hostname}</code>
            </p>
            <StatusChip state={authentication.state === 'pending' ? 'pending' : authentication.state === 'succeeded' ? 'completed' : 'failed'}>{authentication.state === 'pending' ? 'Waiting for authorization' : authentication.state === 'succeeded' ? 'Account connected' : 'Authentication failed'}</StatusChip>
            {authentication.state === 'pending' && (
              <>
                <p>
                  Enter this public user code:
                  {' '}
                  <strong className="device-user-code">{authentication.authorization.userCode}</strong>
                </p>
                <p><a href={authentication.authorization.verificationUri} target="_blank" rel="noreferrer">Authorize on GitHub</a></p>
                <p className="muted">{`Expires ${formatDateTime(authentication.authorization.expiresAt)}. Authorization continues in the background when you leave this page.`}</p>
              </>
            )}
            {authentication.message && <p className={authentication.state === 'failed' ? 'form-error' : undefined}>{authentication.message}</p>}
          </div>
        </Card>
      )}
      <M365Panel canManage={data.capabilities.canManageM365} baseHostname={data.routing.baseHostname} target={data.targets.find(target => target.kind === 'm365')} onRemove={requestRemoval} />
      <ConfirmDialog
        open={removing !== null}
        targetName={removing?.name ?? ''}
        pending={removal.isPending}
        error={removal.error?.message}
        onCancel={() => {
          if (!removal.isPending)
            setRemoving(null)
        }}
        onConfirm={() => {
          if (removing)
            removal.mutate(removing)
        }}
      />
    </>
  )
}

export function TargetsPage() {
  const targets = useTargets()
  return (
    <Region plain title="Target configuration" result={targets.region} retry={() => { void targets.refetch() }} empty={targets.data ? <TargetsConfiguration data={targets.data} /> : undefined}>{data => <TargetsConfiguration data={data} />}</Region>
  )
}
