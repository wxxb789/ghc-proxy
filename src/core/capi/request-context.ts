import type { CapiRequestContext } from './types'

import type { ConversationTurn } from '~/core/conversation'
import type {
  AnthropicCountTokensPayload,
  AnthropicMessagesPayload,
} from '~/translator'
import type {
  ChatCompletionsPayload,
  ResponsesInputTokensPayload,
  ResponsesPayload,
} from '~/types'
import { randomUUID } from 'node:crypto'

import { readHeader } from './headers'
import {
  stripSubagentMarkerFromAnthropicPayload,
  stripSubagentMarkerFromChatPayload,
  stripSubagentMarkerFromResponsesPayload,
  withSubagentMarker,
} from './subagent-marker'

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
    clientSessionId: readHeader(headers, 'x-client-session-id') ?? readHeader(headers, 'x-session-id'),
    interactionId: readHeader(headers, 'x-interaction-id'),
    clientMachineId: readHeader(headers, 'x-client-machine-id'),
  }
}

export function resolveInitiator(
  defaultInitiator: 'user' | 'agent',
  requestContext?: Partial<CapiRequestContext>,
): 'user' | 'agent' {
  switch (requestContext?.interactionType) {
    case 'conversation-agent':
    case 'conversation-subagent':
    case 'conversation-background':
      return 'agent'
    case 'conversation-user':
      return 'user'
    default:
      return defaultInitiator
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

export function normalizeAnthropicRequestContext(
  payload: AnthropicMessagesPayload | AnthropicCountTokensPayload,
  headers: Headers,
): Partial<CapiRequestContext> {
  return withSubagentMarker(readCapiRequestContext(headers), headers, stripSubagentMarkerFromAnthropicPayload(payload))
}

export function normalizeChatRequestContext(
  payload: ChatCompletionsPayload,
  headers: Headers,
): Partial<CapiRequestContext> {
  return withSubagentMarker(readCapiRequestContext(headers), headers, stripSubagentMarkerFromChatPayload(payload))
}

export function normalizeResponsesRequestContext(
  payload: ResponsesPayload | ResponsesInputTokensPayload,
  headers: Headers,
): Partial<CapiRequestContext> {
  return withSubagentMarker(readCapiRequestContext(headers), headers, stripSubagentMarkerFromResponsesPayload(payload))
}
