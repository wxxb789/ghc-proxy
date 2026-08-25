import type { ExecutionResult } from '~/lib/execution-strategy'
import type { Model } from '~/types'

import consola from 'consola'

export interface StrategyEntry<TContext = unknown> {
  name: string
  canHandle: (model: Model | undefined, ctx?: TContext) => boolean
  execute: (ctx: TContext) => Promise<ExecutionResult>
}

export class StrategyRegistry<TContext = unknown> {
  private entries: StrategyEntry<TContext>[] = []

  register(entry: StrategyEntry<TContext>): void {
    this.entries.push(entry)
  }

  listNames(): Array<string> {
    return this.entries.map(entry => entry.name)
  }

  select(model: Model | undefined, ctx?: TContext): StrategyEntry<TContext> {
    if (this.entries.length === 0) {
      throw new Error('StrategyRegistry has no registered entries')
    }

    for (const entry of this.entries) {
      if (entry.canHandle(model, ctx)) {
        consola.debug(`Strategy selected: ${entry.name} for model: ${model?.id ?? '(unknown)'}`)
        return entry
      }
    }

    const fallback = this.entries.at(-1)!
    consola.warn(`No strategy matched for model ${model?.id ?? '(unknown)'}, falling back to: ${fallback.name}`)
    return fallback
  }
}
