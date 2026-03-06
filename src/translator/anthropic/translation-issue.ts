export type TranslationIssueSeverity = 'info' | 'warning' | 'error'

export interface TranslationIssue {
  kind: string
  severity: TranslationIssueSeverity
  message: string
}

export class TranslationFailure extends Error {
  readonly status: 400 | 502
  readonly kind: string

  constructor(
    message: string,
    options: {
      status: 400 | 502
      kind: string
    },
  ) {
    super(message)
    this.name = 'TranslationFailure'
    this.status = options.status
    this.kind = options.kind
  }
}
