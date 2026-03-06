import type { CapiRequestContext } from './types'

import type { ConversationTurn } from '~/core/conversation'
import { randomUUID } from 'node:crypto'

function readHeader(
  headers: Headers,
  name: string,
): string | undefined {
  return headers.get(name) ?? undefined
}

export function inferInitiator(turns: Array<ConversationTurn>): 'user' | 'agent' {
  return turns.some(turn => turn.role === 'assistant' || turn.role === 'tool')
    ? 'agent'
    : 'user'
}

export function readCapiRequestContext(headers: Headers): Partial<CapiRequestContext> {
  return {
    interactionType: (readHeader(headers, 'x-interaction-type') as CapiRequestContext['interactionType'] | undefined),
    agentTaskId: readHeader(headers, 'x-agent-task-id'),
    parentAgentTaskId: readHeader(headers, 'x-parent-agent-id'),
    clientSessionId: readHeader(headers, 'x-client-session-id'),
    interactionId: readHeader(headers, 'x-interaction-id'),
    clientMachineId: readHeader(headers, 'x-client-machine-id'),
  }
}

export function buildCapiRequestContext(
  initiator: 'user' | 'agent',
  overrides: Partial<CapiRequestContext> = {},
): CapiRequestContext {
  return {
    interactionType:
      overrides.interactionType
      ?? (initiator === 'agent'
        ? 'conversation-agent'
        : 'conversation-user'),
    agentTaskId: overrides.agentTaskId,
    parentAgentTaskId: overrides.parentAgentTaskId,
    clientSessionId: overrides.clientSessionId,
    interactionId: overrides.interactionId ?? randomUUID(),
    clientMachineId: overrides.clientMachineId,
  }
}
