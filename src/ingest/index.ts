import { anthropicCountTokensProtocol, anthropicMessagesProtocol } from './anthropic-messages'
import { decisionsProtocol } from './decisions'
import { embeddingsProtocol } from './embeddings'
import { openaiChatProtocol } from './openai-chat'
import { ProtocolRegistry } from './registry'
import { responsesInputTokensProtocol, responsesProtocol } from './responses'

const protocolRegistry = new ProtocolRegistry()

protocolRegistry.register('anthropic-messages', anthropicMessagesProtocol)
protocolRegistry.register('anthropic-count-tokens', anthropicCountTokensProtocol)
protocolRegistry.register('openai-chat', openaiChatProtocol)
protocolRegistry.register('responses', responsesProtocol)
protocolRegistry.register('responses-input-tokens', responsesInputTokensProtocol)
protocolRegistry.register('embeddings', embeddingsProtocol)
protocolRegistry.register('openai-decisions', decisionsProtocol)

export { protocolRegistry }
export type { IngestedRequest, ProtocolHandler, ProtocolId, RequestMeta } from './types'
