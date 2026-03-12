import type { CopilotClient } from '~/clients'
import type { CapiExecutionPlan } from '~/core/capi'

export class CopilotTransport {
  private readonly client: CopilotClient

  constructor(client: CopilotClient) {
    this.client = client
  }

  execute(
    plan: CapiExecutionPlan,
    options?: { signal?: AbortSignal },
  ) {
    return this.client.createChatCompletions(plan.payload, {
      signal: options?.signal,
      initiator: plan.initiator,
      requestContext: plan.requestContext,
    })
  }
}
