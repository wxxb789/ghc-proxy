import type { TranslationIssue } from './translation-issue'
import { TranslationFailure } from './translation-issue'

export interface TranslationPolicy {
  mode: 'best-effort' | 'strict'
}

export const defaultTranslationPolicy: TranslationPolicy = {
  mode: 'best-effort',
}

export class TranslationContext {
  private readonly policy: TranslationPolicy
  private readonly issues: Array<TranslationIssue> = []

  constructor(policy: TranslationPolicy = defaultTranslationPolicy) {
    this.policy = policy
  }

  record(issue: TranslationIssue, options?: { fatalInStrict?: boolean }) {
    this.issues.push(issue)
    if (this.policy.mode === 'strict' && options?.fatalInStrict) {
      throw new TranslationFailure(issue.message, {
        status: 400,
        kind: issue.kind,
      })
    }
  }

  getIssues(): Array<TranslationIssue> {
    return [...this.issues]
  }
}
