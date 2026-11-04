import type { DashboardM365Account, DashboardTarget } from '@contract'
import type { M365AccountBody, M365HostnameBody, M365RegisterBody, M365Result, M365SignInBody } from '../../lib/api'
import { useState } from 'react'
import { useDashboard } from '../../app/context'
import { Region, StatusChip } from '../../components/primitives'
import { formatDateTime, formatInteger } from '../../lib/format'
import { useDashboardMutation } from '../../lib/mutations'
import { dashboardKeys, useM365 } from '../../lib/queries'

function MutationOutcome({ pending, error, success, progress, outcome }: { pending: boolean, error: Error | null, success: boolean, progress: string, outcome: string }) {
  return pending ? <p>{progress}</p> : error ? <p className="form-error">{error.message}</p> : success ? <p>{outcome}</p> : null
}

function M365Management({ data, canManage, baseHostname, target, onRemove }: { data: M365Result, canManage: boolean, baseHostname: string, target?: DashboardTarget, onRemove: (target: DashboardTarget) => void }) {
  const { client } = useDashboard()
  const [hostname, setHostname] = useState<string>()
  const [selection, setSelection] = useState<string>()
  const [email, setEmail] = useState('')
  const [signedInAccount, setSignedInAccount] = useState<DashboardM365Account>()
  const probe = useDashboardMutation({ domains: ['m365'], mutation: api => api.probeM365(), successMessage: 'M365 prerequisite check completed.' })
  const signIn = useDashboardMutation({
    domains: ['m365'],
    mutation: (api, body: M365SignInBody) => api.signInM365(body),
    successMessage: 'Microsoft sign-in completed. Select the account to apply it.',
    onSuccess: (result) => {
      setSignedInAccount(result.account)
      setSelection(result.account.homeAccountId)
    },
  })
  const register = useDashboardMutation({
    domains: ['m365', 'targets', 'overview', 'models', 'behavior'],
    mutation: (api, body: M365RegisterBody) => api.registerM365(body),
    successMessage: 'M365 target added.',
    onSuccess: (result) => { client.setQueryData(dashboardKeys.m365, result) },
  })
  const account = useDashboardMutation({
    domains: ['m365', 'targets', 'overview', 'models'],
    mutation: (api, body: M365AccountBody) => api.selectM365Account(body),
    successMessage: 'M365 account updated.',
    onSuccess: (result) => { client.setQueryData(dashboardKeys.m365, result) },
  })
  const host = useDashboardMutation({
    domains: ['m365', 'targets', 'overview'],
    mutation: (api, body: M365HostnameBody) => api.setM365Hostname(body),
    successMessage: 'M365 hostname saved.',
    onSuccess: (result) => { client.setQueryData(dashboardKeys.m365, result) },
  })
  const busy = probe.isPending || signIn.isPending || register.isPending || account.isPending || host.isPending
  const readiness = probe.data
  const accounts = [...(readiness?.accounts ?? [])]
  if (signedInAccount && !accounts.some(candidate => candidate.homeAccountId === signedInAccount.homeAccountId))
    accounts.push(signedInAccount)
  const currentAccount = data.account
  const currentChoice = accounts.find(candidate => candidate.homeAccountId === currentAccount || candidate.upn === currentAccount)
  const selected = selection ?? currentChoice?.homeAccountId ?? currentAccount ?? ''
  const selectedIsBrokerAccount = accounts.some(candidate => candidate.homeAccountId === selected)
  const manageable = canManage && data.platformSupported && data.onboarding.status === 'available'
  const canSignIn = manageable && readiness?.platformSupported === true && readiness.helperAvailable
  const actualHostname = hostname ?? data.hostname ?? `m365.${baseHostname}`
  return (
    <div className="stack">
      {data.registered
        ? (
            <>
              <div className="inline-controls">
                <StatusChip state={data.availability?.status === 'ready' ? 'ok' : 'unavailable'}>{data.availability?.status === 'ready' ? 'Ready' : 'Unavailable'}</StatusChip>
                <strong>{data.hostname}</strong>
              </div>
              <dl className="target-values">
                <div>
                  <dt>Account</dt>
                  <dd>{data.username ?? data.account ?? 'Not selected'}</dd>
                </div>
                {data.tenant && (
                  <div>
                    <dt>Tenant</dt>
                    <dd>{data.tenant}</dd>
                  </div>
                )}
                <div>
                  <dt>Models</dt>
                  <dd>
                    {formatInteger(data.modelCount)}
                    {' '}
                    ·
                    {' '}
                    {data.models.join(', ') || 'No models loaded'}
                  </dd>
                </div>
                {data.tokenExpiresAt && (
                  <div>
                    <dt>Authorization expires</dt>
                    <dd>{formatDateTime(data.tokenExpiresAt)}</dd>
                  </div>
                )}
                {data.availability?.updatedAt !== undefined && (
                  <div>
                    <dt>Status updated</dt>
                    <dd>{formatDateTime(data.availability.updatedAt)}</dd>
                  </div>
                )}
              </dl>
              {data.availability?.cause && <p className="form-error">{data.availability.cause}</p>}
            </>
          )
        : <p className="muted">M365 is not registered. Check prerequisites explicitly, then choose a broker account or sign in.</p>}
      {!data.platformSupported && <p>Windows is required for M365 broker authentication. This platform is unavailable; no broker discovery has been attempted.</p>}
      {!canManage && <p className="muted">M365 management is unavailable for this process.</p>}
      {data.onboarding.status === 'unavailable' && <p className="muted">{data.onboarding.reason ?? 'M365 onboarding is unavailable for this process.'}</p>}
      {manageable && (
        <>
          <div><button type="button" disabled={busy} onClick={() => probe.mutate()}>Check prerequisites</button></div>
          <MutationOutcome pending={probe.isPending} error={probe.error} success={false} progress="Checking prerequisites…" outcome="" />
          {readiness && (
            <div className="stack" aria-label="M365 readiness">
              <dl className="target-values">
                <div>
                  <dt>Windows platform</dt>
                  <dd>{readiness.platformSupported ? 'Supported' : 'Required'}</dd>
                </div>
                <div>
                  <dt>msc-auth helper</dt>
                  <dd>{readiness.helperAvailable ? 'Available' : 'Unavailable'}</dd>
                </div>
                {readiness.accountCount !== undefined && (
                  <div>
                    <dt>Broker accounts</dt>
                    <dd>{formatInteger(readiness.accountCount)}</dd>
                  </div>
                )}
              </dl>
              {readiness.failedStep && (
                <p className="form-error">{`Failed step: ${readiness.failedStep}`}</p>
              )}
              {readiness.error && <p className="form-error">{readiness.error}</p>}
              {!readiness.failedStep && readiness.accounts?.length === 0 && <p>No broker accounts found. Sign in to Microsoft to add an account.</p>}
            </div>
          )}
          <form
            className="inline-controls"
            onSubmit={(event) => {
              event.preventDefault()
              signIn.mutate(email.trim() ? { upn: email.trim() } : {})
            }}
          >
            <label className="form-field">
              Sign-in email (optional)
              <input type="text" value={email} onChange={event => setEmail(event.target.value)} disabled={busy} autoComplete="username" />
            </label>
            <button type="submit" disabled={busy || !canSignIn}>Sign in to Microsoft</button>
            {!readiness && <p className="muted">Check prerequisites before signing in.</p>}
          </form>
          <MutationOutcome pending={signIn.isPending} error={signIn.error} success={signIn.isSuccess} progress="Complete sign-in in the Windows account dialog…" outcome={`Signed in as ${signedInAccount?.upn || signedInAccount?.homeAccountId || ''}. Select the account to apply it.`} />
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault()
              if (data.registered)
                account.mutate({ account: selected || null })
              else
                register.mutate({ account: selected, hostname: actualHostname })
            }}
          >
            <div className="inline-controls">
              <label className="form-field">
                Broker account
                <select value={selected} onChange={event => setSelection(event.target.value)} disabled={busy}>
                  <option value="">Choose a broker account</option>
                  {currentAccount && !currentChoice && (
                    <option value={currentAccount}>{`Current: ${data.username ?? currentAccount}`}</option>
                  )}
                  {accounts.map(candidate => (
                    <option key={candidate.homeAccountId} value={candidate.homeAccountId}>
                      {candidate.upn || candidate.homeAccountId}
                      {' '}
                      ·
                      {' '}
                      {candidate.homeAccountId}
                      {' '}
                      (
                      {candidate.environment}
                      )
                    </option>
                  ))}
                </select>
              </label>
              {!data.registered && (
                <label className="form-field">
                  M365 hostname
                  <input value={actualHostname} onChange={event => setHostname(event.target.value)} disabled={busy} required />
                </label>
              )}
              <button type="submit" disabled={busy || (data.registered ? !selected : !selectedIsBrokerAccount)}>{data.registered ? 'Use selected account' : 'Add M365 target'}</button>
            </div>
          </form>
          {data.registered && (
            <form
              className="inline-controls"
              onSubmit={(event) => {
                event.preventDefault()
                host.mutate({ hostname: actualHostname })
              }}
            >
              <label className="form-field">
                M365 hostname
                <input value={actualHostname} onChange={event => setHostname(event.target.value)} disabled={busy} required />
              </label>
              <button type="submit" disabled={busy}>Save M365 hostname</button>
            </form>
          )}
          <MutationOutcome pending={register.isPending} error={register.error} success={register.isSuccess} progress="Adding M365 target…" outcome="M365 target added." />
          <MutationOutcome pending={account.isPending} error={account.error} success={account.isSuccess} progress="Updating M365 account…" outcome="M365 account updated." />
          <MutationOutcome pending={host.isPending} error={host.error} success={host.isSuccess} progress="Saving M365 hostname…" outcome="M365 hostname saved." />
          {data.registered && (
            <div className="stack">
              <div>
                <button
                  type="button"
                  className="button-danger"
                  disabled={busy || !target?.actions.canRemove}
                  onClick={() => {
                    if (target)
                      onRemove(target)
                  }}
                >
                  Remove M365 target
                </button>
              </div>
              {!target?.actions.canRemove && <p className="muted">The default or only target cannot be removed.</p>}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function M365Panel({ canManage, baseHostname, target, onRemove }: { canManage: boolean, baseHostname: string, target?: DashboardTarget, onRemove: (target: DashboardTarget) => void }) {
  const m365 = useM365()
  return (
    <Region title="M365 target" result={m365.region} retry={() => { void m365.refetch() }}>{data => <M365Management data={data} canManage={canManage} baseHostname={baseHostname} target={target} onRemove={onRemove} />}</Region>
  )
}
