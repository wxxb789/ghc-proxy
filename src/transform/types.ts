import type { Model } from '~/types'

export interface ModelTransformInput {
  model: string
  payload: unknown
  meta?: { betaHeaders?: string[] }
  resolvedModel?: Model
}

export interface ModelTransformOutput {
  model: string
  resolvedModel?: Model
  tag?: string
  mutatePayload?: (payload: unknown) => void
}

export interface ModelTransformStep {
  readonly tag: string
  apply: (input: ModelTransformInput) => ModelTransformOutput | null
}
