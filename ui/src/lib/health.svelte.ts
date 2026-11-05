// Live derivations over the store: the one Issues model shown in the Issues
// button, the popover and on Overview, plus the summary sentence.
import type { IssueAction, IssueInputs } from './insights.ts'
import { accountsAttention, deriveIssues, summarySentence, worstTone } from './insights.ts'
import { refreshMetadata, retryScope } from './poller.svelte.ts'
import { app, clearFault, faults, samples } from './store.svelte.ts'

function issueInputs(): IssueInputs {
  return {
    now: Date.now(),
    href: location.href,
    overview: app.data.overview,
    overviewAt: app.loadedAt.overview,
    samples: samples.list,
    faults,
    connection: app.connection,
    accountsMode: app.accountsMode,
    accounts: app.data.accounts,
    accountsAt: app.loadedAt.accounts,
    m365: app.data.m365,
    m365At: app.loadedAt.m365,
    restartedAt: app.restartedAt,
    dismissed: app.ui.dismissed,
  }
}

class Health {
  issues = $derived(deriveIssues(issueInputs()))
  /** Tints the Issues button; info issues never do. */
  worst = $derived(worstTone(this.issues))
  summary = $derived(summarySentence(app.data.overview))
  /** Accounts nav lamp from the last-known `/accounts`. */
  accountsLamp = $derived(accountsAttention(app.data.accounts, app.data.m365))
}

export const health = new Health()

/** Runs a non-link issue action (links render as anchors). */
export function runIssueAction(action: IssueAction): void {
  if (action.kind === 'retry' && action.scope)
    void retryScope(action.scope)
  else if (action.kind === 'refresh')
    void refreshMetadata()
  else if (action.kind === 'dismiss' && action.id === 'F2')
    clearFault('metadata')
  else if (action.kind === 'dismiss' && action.id)
    app.ui.dismissed.push(action.id)
}
