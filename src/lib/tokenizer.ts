import type {
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Model,
  Tool,
  ToolCall,
} from '~/types'

// Encoder type mapping
const ENCODING_MAP = {
  o200k_base: () => import('gpt-tokenizer/encoding/o200k_base'),
  cl100k_base: () => import('gpt-tokenizer/encoding/cl100k_base'),
  p50k_base: () => import('gpt-tokenizer/encoding/p50k_base'),
  p50k_edit: () => import('gpt-tokenizer/encoding/p50k_edit'),
  r50k_base: () => import('gpt-tokenizer/encoding/r50k_base'),
} as const

type SupportedEncoding = keyof typeof ENCODING_MAP

// Define encoder interface
interface Encoder {
  encode: (text: string) => Array<number>
}

// Cache loaded encoders to avoid repeated imports
const encodingCache = new Map<string, Encoder>()

// Token counting constants
const TOKENS_PER_MESSAGE = 3
const TOKENS_PER_NAME = 1
const REPLY_PRIMING_TOKENS = 3

// Model-specific constants for tool token calculation
const BASE_CONSTANTS = {
  propertyInitOverhead: 3,
  propertyKeyOverhead: 3,
  enumOverhead: -3,
  enumItemCost: 3,
  functionEndOverhead: 12,
}

type ModelConstants = typeof BASE_CONSTANTS & { functionInitOverhead: number }

/**
 * Calculate tokens for tool calls
 */
function calculateToolCallsTokens(toolCalls: Array<ToolCall>, encoder: Encoder, constants: ModelConstants): number {
  let tokens = 0
  for (const toolCall of toolCalls) {
    tokens += constants.functionInitOverhead
    tokens += encoder.encode(JSON.stringify(toolCall)).length
  }
  tokens += constants.functionEndOverhead
  return tokens
}

/**
 * Calculate tokens for content parts
 */
function calculateContentPartsTokens(contentParts: Array<ContentPart>, encoder: Encoder): number {
  let tokens = 0
  for (const part of contentParts) {
    if (part.type === 'image_url') {
      tokens += encoder.encode(part.image_url.url).length + 85
    }
    else if (part.text) {
      tokens += encoder.encode(part.text).length
    }
  }
  return tokens
}

/**
 * Calculate tokens for a single message
 */
function calculateMessageTokens(message: Message, encoder: Encoder, constants: ModelConstants): number {
  let tokens = TOKENS_PER_MESSAGE
  for (const [key, value] of Object.entries(message)) {
    if (typeof value === 'string') {
      tokens += encoder.encode(value).length
    }
    if (key === 'name') {
      tokens += TOKENS_PER_NAME
    }
    if (key === 'tool_calls') {
      tokens += calculateToolCallsTokens(
        value as Array<ToolCall>,
        encoder,
        constants,
      )
    }
    if (key === 'content' && Array.isArray(value)) {
      tokens += calculateContentPartsTokens(
        value as Array<ContentPart>,
        encoder,
      )
    }
  }
  return tokens
}

/**
 * Calculate tokens using custom algorithm
 */
function calculateTokens(messages: Array<Message>, encoder: Encoder, constants: ModelConstants): number {
  if (messages.length === 0) {
    return 0
  }
  let numTokens = 0
  for (const message of messages) {
    numTokens += calculateMessageTokens(message, encoder, constants)
  }
  // every reply is primed with <|start|>assistant<|message|>
  numTokens += REPLY_PRIMING_TOKENS
  return numTokens
}

/**
 * Get the corresponding encoder module based on encoding type
 */
async function getEncoder(encoding: string): Promise<Encoder> {
  const cached = encodingCache.get(encoding)
  if (cached)
    return cached

  const supportedEncoding = encoding as SupportedEncoding
  if (!(supportedEncoding in ENCODING_MAP)) {
    const fallbackModule = (await ENCODING_MAP.o200k_base()) as Encoder
    encodingCache.set(encoding, fallbackModule)
    return fallbackModule
  }

  const encodingModule = (await ENCODING_MAP[supportedEncoding]()) as Encoder
  encodingCache.set(encoding, encodingModule)
  return encodingModule
}

/**
 * Get tokenizer type from model information
 */
export function getTokenizerFromModel(model: Model): string {
  return model.capabilities.tokenizer || 'o200k_base'
}

/**
 * Get model-specific constants for token calculation
 */
function getModelConstants(model: Model): ModelConstants {
  const isLegacy = model.id === 'gpt-3.5-turbo' || model.id === 'gpt-4'
  return { ...BASE_CONSTANTS, functionInitOverhead: isLegacy ? 10 : 7 }
}

/**
 * Calculate tokens for a single parameter
 */
function calculateParameterTokens(key: string, prop: unknown, context: {
  encoder: Encoder
  constants: ModelConstants
}): number {
  const { encoder, constants } = context
  let tokens = constants.propertyKeyOverhead

  // Early return if prop is not an object
  if (typeof prop !== 'object' || prop === null) {
    return tokens
  }

  // Type assertion for parameter properties
  const param = prop as {
    type?: string
    description?: string
    enum?: Array<unknown>
    [key: string]: unknown
  }

  const paramName = key
  const paramType = param.type || 'string'
  let paramDesc = param.description || ''

  // Handle enum values
  if (param.enum && Array.isArray(param.enum)) {
    tokens += constants.enumOverhead
    for (const item of param.enum) {
      tokens += constants.enumItemCost
      tokens += encoder.encode(String(item)).length
    }
  }

  // Clean up description
  if (paramDesc.endsWith('.')) {
    paramDesc = paramDesc.slice(0, -1)
  }

  // Encode the main parameter line
  const line = `${paramName}:${paramType}:${paramDesc}`
  tokens += encoder.encode(line).length

  // Handle additional properties (excluding standard ones)
  const excludedKeys = new Set(['type', 'description', 'enum'])
  for (const propertyName of Object.keys(param)) {
    if (!excludedKeys.has(propertyName)) {
      const propertyValue = param[propertyName]
      const propertyText
        = typeof propertyValue === 'string'
          ? propertyValue
          : (
              JSON.stringify(propertyValue)
            )
      tokens += encoder.encode(`${propertyName}:${propertyText}`).length
    }
  }

  return tokens
}

/**
 * Calculate tokens for function parameters
 */
function calculateParametersTokens(parameters: unknown, encoder: Encoder, constants: ModelConstants): number {
  if (!parameters || typeof parameters !== 'object') {
    return 0
  }

  const params = parameters as Record<string, unknown>
  let tokens = 0

  for (const [key, value] of Object.entries(params)) {
    if (key === 'properties') {
      const properties = value as Record<string, unknown>
      if (Object.keys(properties).length > 0) {
        tokens += constants.propertyInitOverhead
        for (const propKey of Object.keys(properties)) {
          tokens += calculateParameterTokens(propKey, properties[propKey], {
            encoder,
            constants,
          })
        }
      }
    }
    else {
      const paramText
        = typeof value === 'string' ? value : JSON.stringify(value)
      tokens += encoder.encode(`${key}:${paramText}`).length
    }
  }

  return tokens
}

/**
 * Calculate tokens for a single tool
 */
function calculateToolTokens(tool: Tool, encoder: Encoder, constants: ModelConstants): number {
  let tokens = constants.functionInitOverhead
  const func = tool.function
  const functionName = func.name
  let functionDescription = func.description || ''
  if (functionDescription.endsWith('.')) {
    functionDescription = functionDescription.slice(0, -1)
  }
  const line = `${functionName}:${functionDescription}`
  tokens += encoder.encode(line).length
  if (
    typeof func.parameters === 'object'
    && func.parameters !== null
  ) {
    tokens += calculateParametersTokens(func.parameters, encoder, constants)
  }
  return tokens
}

/**
 * Calculate token count for tools based on model
 */
export function numTokensForTools(tools: Array<Tool>, encoder: Encoder, constants: ModelConstants): number {
  let toolTokenCount = 0
  for (const tool of tools) {
    toolTokenCount += calculateToolTokens(tool, encoder, constants)
  }
  toolTokenCount += constants.functionEndOverhead
  return toolTokenCount
}

/**
 * Calculate the token count of messages, supporting multiple GPT encoders
 */
export async function getTokenCount(payload: ChatCompletionsPayload, model: Model): Promise<{ input: number, output: number }> {
  // Get tokenizer string
  const tokenizer = getTokenizerFromModel(model)

  // Get corresponding encoder module
  const encoder = await getEncoder(tokenizer)

  const inputMessages = payload.messages.filter(
    msg => msg.role !== 'assistant',
  )
  const outputMessages = payload.messages.filter(
    msg => msg.role === 'assistant',
  )

  const constants = getModelConstants(model)
  let inputTokens = calculateTokens(inputMessages, encoder, constants)
  if (payload.tools && payload.tools.length > 0) {
    inputTokens += numTokensForTools(payload.tools, encoder, constants)
  }
  const outputTokens = calculateTokens(outputMessages, encoder, constants)

  return {
    input: inputTokens,
    output: outputTokens,
  }
}
