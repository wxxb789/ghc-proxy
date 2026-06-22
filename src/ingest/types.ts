import type { CapiRequestContext } from '~/core/capi'

export type ProtocolId
  = | 'anthropic-messages'
    | 'anthropic-count-tokens'
    | 'openai-chat'
    | 'responses'
    | 'responses-input-tokens'
    | 'embeddings'

export interface RequestMeta {
  sessionId?: string
  betaHeaders?: string[]
  requestContext?: Partial<CapiRequestContext>
}

export interface ProtocolHandler<TPayload = unknown> {
  parse: (body: unknown) => TPayload
  extractMeta: (payload: TPayload, headers: Headers) => RequestMeta
}

export interface IngestedRequest<TPayload = unknown> {
  protocol: ProtocolId
  payload: TPayload
  meta: RequestMeta
}
