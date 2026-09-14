import type {
  ResponsesChatRequest,
  ResponsesChatTool,
} from './chat-bridge-types'
import type {
  CapiChatCompletionsPayload,
  CapiExecutionPlan,
  CapiRequestContext,
  CapiResponseFormat,
  CapiToolWithStrict,
} from '~/core/capi'
import type {
  ConversationBlock,
  ConversationImageBlock,
  ConversationRequest,
  ConversationTextBlock,
  ConversationTool,
  ConversationToolChoice,
  ConversationTurn,
} from '~/core/conversation'
import type { TranslationIssue } from '~/translator/anthropic/translation-issue'
import type {
  Model,
  ResponsesPayload,
} from '~/types'

import { buildCapiExecutionPlan } from '~/core/capi'
import { applyChatCompletionsTokenParam } from '~/transform/parameter-filter'
import { TranslationFailure } from '~/translator/anthropic/translation-issue'
import { TranslationContext } from '~/translator/anthropic/translation-policy'
import { isPinnedApplyPatchGrammar } from './apply-patch-grammar'

const HTTP_URL_RE = /^https?:\/\//i
const DATA_URL_RE = /^data:[^,]+,/i
const INVALID_ALIAS_CHARS_RE = /[^\w-]/g
const CHAT_NAME_MAX_LENGTH = 64

const PAYLOAD_KEYS = new Set([
  'background',
  'model',
  'instructions',
  'input',
  'conversation',
  'previous_response_id',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'top_k',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'stream',
  'stream_options',
  'safety_identifier',
  'prompt_cache_key',
  'prompt_cache_options',
  'prompt_cache_retention',
  'truncation',
  'parallel_tool_calls',
  'store',
  'user',
  'prompt',
  'text',
  'reasoning',
  'context_management',
  'include',
  'service_tier',
  'client_metadata',
])

const FUNCTION_TOOL_KEYS = new Set([
  'type',
  'name',
  'description',
  'parameters',
  'strict',
  'namespace',
])

const CUSTOM_TOOL_KEYS = new Set([
  'type',
  'name',
  'description',
  'format',
  'namespace',
])

const MESSAGE_KEYS = new Set(['type', 'id', 'role', 'content', 'status', 'phase', 'annotations', 'logprobs'])
const TEXT_CONTENT_KEYS = new Set(['type', 'text', 'prompt_cache_breakpoint', 'annotations', 'logprobs'])
const IMAGE_CONTENT_KEYS = new Set(['type', 'image_url', 'file_id', 'detail', 'prompt_cache_breakpoint', 'annotations', 'logprobs'])
const REFUSAL_CONTENT_KEYS = new Set(['type', 'refusal'])
const FUNCTION_CALL_KEYS = new Set(['type', 'id', 'call_id', 'name', 'namespace', 'arguments', 'status'])
const CUSTOM_CALL_KEYS = new Set(['type', 'id', 'call_id', 'name', 'namespace', 'input', 'status'])
const TOOL_OUTPUT_KEYS = new Set(['type', 'id', 'call_id', 'name', 'namespace', 'output', 'status'])
const REASONING_KEYS = new Set(['type', 'id', 'summary', 'encrypted_content', 'status'])
const COMPACTION_KEYS = new Set(['type', 'id', 'encrypted_content'])
const TOOL_CHOICE_KEYS = new Set(['type', 'name', 'namespace', 'mode', 'tools'])
const ALLOWED_TOOL_KEYS = new Set(['type', 'name', 'namespace'])
const TEXT_KEYS = new Set(['format', 'verbosity'])
const SIMPLE_FORMAT_KEYS = new Set(['type'])
const JSON_SCHEMA_KEYS = new Set(['type', 'name', 'schema', 'description', 'strict'])
const REASONING_CONFIG_KEYS = new Set(['effort', 'generate_summary', 'summary'])
const STREAM_OPTIONS_KEYS = new Set(['include_obfuscation'])
const GRAMMAR_KEYS = new Set(['type', 'syntax', 'definition'])

type RecordValue = Record<string, unknown>
type ToolKind = 'function' | 'custom'

interface ToolDescriptor {
  key: string
  type: ToolKind
  name: string
  namespace?: string
  description?: string
  parameters: Record<string, unknown>
  strict?: boolean
  current: boolean
}

interface ParsedMessageItem {
  kind: 'message'
  turn: ConversationTurn
}

interface ParsedCallItem {
  kind: 'call'
  callKind: ToolKind
  callId: string
  name: string
  namespace?: string
  argumentsText: string
  input: Record<string, unknown>
}

interface ParsedOutputItem {
  kind: 'output'
  outputKind: ToolKind
  callId: string
  name?: string
  namespace?: string
  content: Array<ConversationTextBlock | ConversationImageBlock>
}

type ParsedInputItem = ParsedMessageItem | ParsedCallItem | ParsedOutputItem

interface AliasRegistry {
  aliasFor: (key: string) => string
  entries: () => Array<[string, ToolDescriptor]>
}

interface ResponsesToChatOptions {
  requestContext?: Partial<CapiRequestContext>
  allowApplyPatchGrammar?: boolean
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(kind: string, message: string): never {
  throw new TranslationFailure(message, { status: 400, kind })
}

function assertKnownKeys(value: unknown, keys: Set<string>, path: string): void {
  if (!isRecord(value)) {
    fail('unsupported_responses_field', `${path} must be an object.`)
  }
  for (const [key, nested] of Object.entries(value)) {
    if (!keys.has(key) && nested !== null && nested !== undefined) {
      fail('unsupported_responses_field', `${path}.${key} is not supported by the Responses-to-Chat bridge.`)
    }
  }
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_responses_field', `${path} must be a non-empty string when provided.`)
  }
  return value
}

function requiredString(value: unknown, path: string): string {
  const result = optionalString(value, path)
  if (!result) {
    fail('invalid_responses_field', `${path} is required.`)
  }
  return result
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    fail('invalid_responses_field', `${path} must be a string.`)
  }
  return value
}

function recordIssue(
  context: TranslationContext,
  kind: string,
  message: string,
): void {
  context.record({ kind, severity: 'warning', message })
}

function recordOutputMetadataIssue(
  value: unknown,
  context: TranslationContext,
): void {
  if (value === undefined || value === null) {
    return
  }
  if (!Array.isArray(value)) {
    fail('unsupported_responses_field', 'Responses output metadata must be an array when replayed as input.')
  }
  if (value.length > 0) {
    recordIssue(
      context,
      'lossy_response_item_metadata',
      'Responses output metadata was omitted from Chat input.',
    )
  }
}

function recordPromptCacheBreakpointIssue(
  value: unknown,
  path: string,
  context: TranslationContext,
): void {
  if (value === undefined || value === null) {
    return
  }
  if (!isRecord(value)) {
    fail('unsupported_responses_field', `${path}.prompt_cache_breakpoint must be an object.`)
  }
  assertKnownKeys(value, new Set(['mode']), `${path}.prompt_cache_breakpoint`)
  if (value.mode !== 'explicit') {
    fail('unsupported_responses_field', `${path}.prompt_cache_breakpoint.mode must be explicit.`)
  }
  recordIssue(
    context,
    'lossy_prompt_cache_breakpoint',
    `${path}.prompt_cache_breakpoint is advisory and was omitted from Chat input.`,
  )
}

function toolKey(type: ToolKind, name: string, namespace?: string): string {
  return `${type}\u0000${namespace ?? ''}\u0000${name}`
}

function parseNamespace(value: unknown, path: string): string | undefined {
  return optionalString(value, path)
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function sanitizeAliasPart(value: string): string {
  const sanitized = value.replace(INVALID_ALIAS_CHARS_RE, '_')
  return sanitized || 'tool'
}

function aliasCandidate(descriptor: ToolDescriptor): string {
  const name = sanitizeAliasPart(descriptor.name)
  return descriptor.namespace
    ? `${sanitizeAliasPart(descriptor.namespace)}__${name}`
    : name
}

function boundedAlias(descriptor: ToolDescriptor, candidate: string): string {
  const suffix = `_${stableHash(descriptor.key)}`
  if (candidate.length + suffix.length <= CHAT_NAME_MAX_LENGTH) {
    return `${candidate}${suffix}`
  }
  return `${candidate.slice(0, CHAT_NAME_MAX_LENGTH - suffix.length)}${suffix}`
}

function createAliasRegistry(descriptors: Map<string, ToolDescriptor>): AliasRegistry {
  const ordered = [...descriptors.entries()].sort(([left], [right]) => left.localeCompare(right))
  const candidateCounts = new Map<string, number>()
  for (const [, descriptor] of ordered) {
    const candidate = aliasCandidate(descriptor)
    candidateCounts.set(candidate, (candidateCounts.get(candidate) ?? 0) + 1)
  }

  const aliases = new Map<string, string>()
  const used = new Set<string>()
  for (const [key, descriptor] of ordered) {
    const candidate = aliasCandidate(descriptor)
    let alias = candidate.length <= CHAT_NAME_MAX_LENGTH && candidateCounts.get(candidate) === 1
      ? candidate
      : boundedAlias(descriptor, candidate)
    let collision = 0
    while (used.has(alias)) {
      collision++
      const suffix = `_${stableHash(`${descriptor.key}:${collision}`)}`
      alias = `${candidate.slice(0, Math.max(1, CHAT_NAME_MAX_LENGTH - suffix.length))}${suffix}`
    }
    used.add(alias)
    aliases.set(key, alias)
  }

  return {
    aliasFor(key: string): string {
      const alias = aliases.get(key)
      if (!alias) {
        fail('invalid_tool_alias', `No Chat alias was allocated for tool key ${key}.`)
      }
      return alias
    },
    entries(): Array<[string, ToolDescriptor]> {
      return ordered
    },
  }
}

function parseToolParameters(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (value === undefined || value === null) {
    return { type: 'object', properties: {} }
  }
  if (!isRecord(value)) {
    fail('invalid_tool_schema', `${path} must be a JSON object.`)
  }
  // The Chat bridge must preserve the caller's schema exactly. Native
  // Responses transforms may normalize provider annotations, but applying
  // that policy here would silently change a request before the fallback.
  return value
}

function parseToolDeclarations(
  payload: ResponsesPayload,
  model: Model,
  context: TranslationContext,
  allowApplyPatchGrammar: boolean,
): { ordered: Array<ToolDescriptor>, byKey: Map<string, ToolDescriptor> } {
  const ordered: Array<ToolDescriptor> = []
  const byKey = new Map<string, ToolDescriptor>()
  if (!Array.isArray(payload.tools)) {
    return { ordered, byKey }
  }

  for (const [index, rawTool] of payload.tools.entries()) {
    if (!isRecord(rawTool)) {
      fail('invalid_tool_schema', `tools[${index}] must be an object.`)
    }
    const type = requiredString(rawTool.type, `tools[${index}].type`)

    let descriptor: ToolDescriptor
    if (type === 'function') {
      assertKnownKeys(rawTool, FUNCTION_TOOL_KEYS, `tools[${index}]`)
      const name = requiredString(rawTool.name, `tools[${index}].name`)
      const namespace = parseNamespace(rawTool.namespace, `tools[${index}].namespace`)
      const descriptionValue = rawTool.description ?? undefined
      const description = descriptionValue === undefined
        ? undefined
        : requiredText(descriptionValue, `tools[${index}].description`)
      const strict = rawTool.strict ?? undefined
      if (strict !== undefined && typeof strict !== 'boolean') {
        fail('invalid_tool_schema', `tools[${index}].strict must be boolean when provided.`)
      }
      if (strict === true && model.capabilities.supports.structured_outputs !== true) {
        fail(
          'unsupported_structured_output',
          `tools[${index}].strict=true cannot be preserved for model ${model.id}.`,
        )
      }
      if (strict === undefined) {
        recordIssue(
          context,
          'lossy_function_tool_strict_omitted',
          `tools[${index}] omitted strict; Chat cannot make the Responses strictness promise.`,
        )
      }
      descriptor = {
        key: toolKey('function', name, namespace),
        type: 'function',
        name,
        namespace,
        description,
        parameters: parseToolParameters(rawTool.parameters, `tools[${index}].parameters`),
        ...(strict !== undefined ? { strict } : {}),
        current: true,
      }
    }
    else if (type === 'custom') {
      assertKnownKeys(rawTool, CUSTOM_TOOL_KEYS, `tools[${index}]`)
      const name = requiredString(rawTool.name, `tools[${index}].name`)
      const namespace = parseNamespace(rawTool.namespace, `tools[${index}].namespace`)
      const descriptionValue = rawTool.description ?? undefined
      const description = descriptionValue === undefined
        ? undefined
        : requiredText(descriptionValue, `tools[${index}].description`)
      const format = rawTool.format
      if (format !== undefined && format !== null) {
        if (!isRecord(format)) {
          fail('unsupported_apply_patch_grammar', `tools[${index}].format must be an object.`)
        }
        const formatType = requiredString(format.type, `tools[${index}].format.type`)
        if (formatType === 'text') {
          assertKnownKeys(format, SIMPLE_FORMAT_KEYS, `tools[${index}].format`)
        }
        else {
          assertKnownKeys(format, GRAMMAR_KEYS, `tools[${index}].format`)
          const syntax = requiredString(format.syntax, `tools[${index}].format.syntax`)
          const definition = requiredString(format.definition, `tools[${index}].format.definition`)
          if (name !== 'apply_patch' || syntax !== 'lark' || formatType !== 'grammar') {
            fail(
              'unsupported_apply_patch_grammar',
              `Custom grammar for ${name} cannot be represented by Chat Completions.`,
            )
          }
          if (!allowApplyPatchGrammar || !isPinnedApplyPatchGrammar(definition)) {
            fail(
              'unsupported_apply_patch_grammar',
              'The apply_patch grammar is not in the pinned bridge allowlist or the shim is disabled.',
            )
          }
          recordIssue(
            context,
            'lossy_custom_tool_grammar',
            'The apply_patch grammar is lowered to a string-input function tool.',
          )
        }
      }
      descriptor = {
        key: toolKey('custom', name, namespace),
        type: 'custom',
        name,
        namespace,
        description,
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
        current: true,
      }
    }
    else {
      fail('unsupported_hosted_tool', `Tool type ${type} cannot be executed through Chat Completions.`)
    }

    if (byKey.has(descriptor.key)) {
      fail('duplicate_tool', `Tool ${descriptor.name} is declared more than once.`)
    }
    byKey.set(descriptor.key, descriptor)
    ordered.push(descriptor)
  }

  return { ordered, byKey }
}

function parseImageContent(
  content: RecordValue,
  path: string,
  context: TranslationContext,
): ConversationImageBlock {
  assertKnownKeys(content, IMAGE_CONTENT_KEYS, path)
  if (content.file_id !== undefined && content.file_id !== null) {
    fail('unsupported_input_file', `${path}.file_id cannot be resolved by the Chat bridge.`)
  }
  const url = requiredString(content.image_url, `${path}.image_url`)
  if (!HTTP_URL_RE.test(url) && !DATA_URL_RE.test(url)) {
    fail('unsupported_input_image', `${path}.image_url must be an HTTP(S) or data URL.`)
  }
  const detail = content.detail
  if (detail !== undefined && detail !== 'low' && detail !== 'high' && detail !== 'auto') {
    fail('unsupported_image_detail', `${path}.detail=${String(detail)} is not supported by Chat.`)
  }
  recordPromptCacheBreakpointIssue(content.prompt_cache_breakpoint, path, context)
  recordOutputMetadataIssue(content.annotations, context)
  recordOutputMetadataIssue(content.logprobs, context)
  return {
    kind: 'image',
    url,
    ...(detail ? { detail } : {}),
  }
}

function parseContentBlocks(
  content: unknown,
  path: string,
  context: TranslationContext,
): Array<ConversationTextBlock | ConversationImageBlock> {
  if (typeof content === 'string') {
    return [{ kind: 'text', text: content }]
  }
  if (content === undefined || content === null) {
    return [{ kind: 'text', text: '' }]
  }
  if (!Array.isArray(content)) {
    fail('unsupported_input_content', `${path} must be a string or content array.`)
  }
  if (content.length === 0) {
    return [{ kind: 'text', text: '' }]
  }

  return content.map((rawBlock, index) => {
    if (!isRecord(rawBlock))
      return fail('unsupported_input_content', `${path}[${index}] must be an object.`)
    const type = requiredString(rawBlock.type, `${path}[${index}].type`)
    if (type === 'input_text' || type === 'output_text') {
      assertKnownKeys(rawBlock, TEXT_CONTENT_KEYS, `${path}[${index}]`)
      recordOutputMetadataIssue(rawBlock.annotations, context)
      recordOutputMetadataIssue(rawBlock.logprobs, context)
      recordPromptCacheBreakpointIssue(rawBlock.prompt_cache_breakpoint, `${path}[${index}]`, context)
      return {
        kind: 'text',
        text: requiredText(rawBlock.text, `${path}[${index}].text`),
      }
    }
    if (type === 'refusal') {
      assertKnownKeys(rawBlock, REFUSAL_CONTENT_KEYS, `${path}[${index}]`)
      recordIssue(context, 'lossy_refusal_content', `${path}[${index}] refusal was flattened to text for Chat input.`)
      return {
        kind: 'text',
        text: requiredText(rawBlock.refusal, `${path}[${index}].refusal`),
      }
    }
    if (type === 'input_image') {
      return parseImageContent(rawBlock, `${path}[${index}]`, context)
    }
    if (type === 'input_file')
      return fail('unsupported_input_file', `${path}[${index}] file attachments are not supported by the Chat bridge.`)
    return fail('unsupported_input_content', `${path}[${index}].type=${type} is not supported by the Chat bridge.`)
  })
}

function parseMessageItem(
  item: RecordValue,
  path: string,
  context: TranslationContext,
): ParsedMessageItem {
  assertKnownKeys(item, MESSAGE_KEYS, path)
  const role = requiredString(item.role, `${path}.role`)
  if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'developer') {
    fail('unsupported_message_role', `${path}.role=${role} is not supported.`)
  }
  const status = item.status
  if (status === 'in_progress' || status === 'incomplete') {
    fail('invalid_function_call_history', `${path}.status=${status} is not a complete message.`)
  }
  if (status !== undefined && status !== null && status !== 'completed') {
    recordIssue(context, 'lossy_message_status', `${path}.status was omitted from Chat input.`)
  }
  if (item.id !== undefined && item.id !== null) {
    optionalString(item.id, `${path}.id`)
    recordIssue(context, 'lossy_response_item_metadata', `${path}.id was omitted from Chat input.`)
  }
  recordOutputMetadataIssue(item.annotations, context)
  recordOutputMetadataIssue(item.logprobs, context)
  const phase = item.phase
  if (phase !== undefined && phase !== null && phase !== 'commentary' && phase !== 'final_answer') {
    fail('unsupported_responses_field', `${path}.phase=${String(phase)} is not supported.`)
  }
  if (phase && role !== 'assistant') {
    recordIssue(context, 'lossy_message_phase', `${path}.phase is only representable on assistant Chat messages.`)
  }
  const blocks = parseContentBlocks(item.content, `${path}.content`, context)
  return {
    kind: 'message',
    turn: {
      role,
      blocks,
      ...(phase && role === 'assistant' ? { meta: { phase } } : {}),
    },
  }
}

function parseNamespaceFromItem(item: RecordValue, path: string): string | undefined {
  return parseNamespace(item.namespace, `${path}.namespace`)
}

function parseFunctionCallItem(
  item: RecordValue,
  path: string,
  declared: Map<string, ToolDescriptor>,
  context: TranslationContext,
): ParsedCallItem {
  assertKnownKeys(item, FUNCTION_CALL_KEYS, path)
  const callId = requiredString(item.call_id, `${path}.call_id`)
  const name = requiredString(item.name, `${path}.name`)
  const namespace = parseNamespaceFromItem(item, path)
  if (item.id !== undefined && item.id !== null) {
    optionalString(item.id, `${path}.id`)
    recordIssue(context, 'lossy_response_item_metadata', `${path}.id was omitted from Chat input.`)
  }
  const argumentsText = typeof item.arguments === 'string'
    ? item.arguments
    : fail('invalid_function_call_history', `${path}.arguments must be a JSON string.`)
  if (item.status !== undefined && item.status !== null && item.status !== 'completed') {
    fail('invalid_function_call_history', `${path}.status=${String(item.status)} is unresolved.`)
  }
  const custom = declared.get(toolKey('custom', name, namespace))
  const functionTool = declared.get(toolKey('function', name, namespace))
  const callKind: ToolKind = custom && !functionTool ? 'custom' : 'function'
  if (callKind === 'custom') {
    const input = unwrapCustomInput(argumentsText)
    return {
      kind: 'call',
      callKind,
      callId,
      name,
      namespace,
      argumentsText: JSON.stringify({ input }),
      input: { input },
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsText)
  }
  catch {
    fail('invalid_function_call_history', `${path}.arguments is not valid JSON.`)
  }
  if (!isRecord(parsed)) {
    fail('invalid_function_call_history', `${path}.arguments must decode to a JSON object.`)
  }
  return {
    kind: 'call',
    callKind,
    callId,
    name,
    namespace,
    argumentsText,
    input: parsed,
  }
}

function unwrapCustomInput(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as unknown
    if (isRecord(parsed) && typeof parsed.input === 'string') {
      return parsed.input
    }
  }
  catch {
    // A historical custom call may carry raw freeform text. Preserve it as-is.
  }
  return argumentsText
}

function parseCustomCallItem(
  item: RecordValue,
  path: string,
  context: TranslationContext,
): ParsedCallItem {
  assertKnownKeys(item, CUSTOM_CALL_KEYS, path)
  const callId = requiredString(item.call_id, `${path}.call_id`)
  const name = requiredString(item.name, `${path}.name`)
  const namespace = parseNamespaceFromItem(item, path)
  if (item.id !== undefined && item.id !== null) {
    optionalString(item.id, `${path}.id`)
    recordIssue(context, 'lossy_response_item_metadata', `${path}.id was omitted from Chat input.`)
  }
  const input = requiredText(item.input, `${path}.input`)
  if (item.status !== undefined && item.status !== null && item.status !== 'completed') {
    fail('invalid_custom_tool_call', `${path}.status=${String(item.status)} is unresolved.`)
  }
  return {
    kind: 'call',
    callKind: 'custom',
    callId,
    name,
    namespace,
    argumentsText: JSON.stringify({ input }),
    input: { input },
  }
}

function parseOutputItem(
  item: RecordValue,
  path: string,
  outputKind: ToolKind,
  context: TranslationContext,
): ParsedOutputItem {
  assertKnownKeys(item, TOOL_OUTPUT_KEYS, path)
  const callId = requiredString(item.call_id, `${path}.call_id`)
  const name = item.name == null ? undefined : requiredString(item.name, `${path}.name`)
  const namespace = parseNamespaceFromItem(item, path)
  if (item.id !== undefined && item.id !== null) {
    optionalString(item.id, `${path}.id`)
    recordIssue(context, 'lossy_response_item_metadata', `${path}.id was omitted from Chat input.`)
  }
  if (item.status !== undefined && item.status !== null && item.status !== 'completed') {
    fail('invalid_function_call_history', `${path}.status=${String(item.status)} is unresolved.`)
  }
  if (outputKind === 'custom') {
    const output = item.output
    const text = requiredText(output, `${path}.output`)
    return { kind: 'output', outputKind, callId, name, namespace, content: [{ kind: 'text', text }] }
  }
  const output = item.output
  if (output === undefined || output === null) {
    fail('invalid_function_call_history', `${path}.output is required.`)
  }
  return {
    kind: 'output',
    outputKind,
    callId,
    name,
    namespace,
    content: parseContentBlocks(output, `${path}.output`, context),
  }
}

function parseReasoningItem(item: RecordValue, path: string, context: TranslationContext): void {
  assertKnownKeys(item, REASONING_KEYS, path)
  if (item.encrypted_content !== undefined && item.encrypted_content !== null) {
    fail('unsupported_encrypted_reasoning', `${path}.encrypted_content cannot be decrypted or replayed through Chat.`)
  }
  const summary = item.summary
  if (summary !== undefined && summary !== null) {
    if (!Array.isArray(summary)) {
      fail('unsupported_responses_field', `${path}.summary must be an array.`)
    }
    for (const [index, value] of summary.entries()) {
      if (!isRecord(value)) {
        fail('unsupported_responses_field', `${path}.summary[${index}] must be an object.`)
      }
      assertKnownKeys(value, new Set(['type', 'text']), `${path}.summary[${index}]`)
      if (value.type !== 'summary_text' || typeof value.text !== 'string') {
        fail('unsupported_responses_field', `${path}.summary[${index}] is not a summary_text item.`)
      }
    }
  }
  recordIssue(
    context,
    'lossy_reasoning_omitted_from_prompt',
    `${path} plain reasoning history was omitted because Chat has no replayable reasoning contract.`,
  )
}

function parseInputItems(
  payload: ResponsesPayload,
  declared: Map<string, ToolDescriptor>,
  context: TranslationContext,
): Array<ParsedInputItem> {
  if (payload.input === undefined || payload.input === null) {
    return []
  }
  if (typeof payload.input === 'string') {
    return [{
      kind: 'message',
      turn: { role: 'user', blocks: [{ kind: 'text', text: payload.input }] },
    }]
  }
  if (!Array.isArray(payload.input)) {
    fail('unsupported_input_content', 'input must be a string or an array.')
  }

  const result: Array<ParsedInputItem> = []
  const callIds = new Set<string>()
  for (const [index, rawItem] of payload.input.entries()) {
    if (!isRecord(rawItem)) {
      fail('unsupported_input_content', `input[${index}] must be an object.`)
    }
    const path = `input[${index}]`
    const type = rawItem.type
    if (type === undefined || type === null || type === 'message') {
      result.push(parseMessageItem(rawItem, path, context))
      continue
    }
    let parsed: ParsedInputItem
    switch (type) {
      case 'function_call':
        parsed = parseFunctionCallItem(rawItem, path, declared, context)
        break
      case 'custom_tool_call':
        parsed = parseCustomCallItem(rawItem, path, context)
        break
      case 'function_call_output':
        parsed = parseOutputItem(rawItem, path, 'function', context)
        break
      case 'custom_tool_call_output':
        parsed = parseOutputItem(rawItem, path, 'custom', context)
        break
      case 'reasoning':
        parseReasoningItem(rawItem, path, context)
        continue
      case 'compaction':
        assertKnownKeys(rawItem, COMPACTION_KEYS, path)
        return fail('unsupported_responses_compaction', 'Compaction history cannot be replayed through Chat Completions.')
      case 'item_reference':
        return fail('unsupported_responses_state', 'item_reference requires server-side Responses state and is not resolvable by Chat.')
      default:
        return fail('unsupported_hosted_tool', `Input item type ${String(type)} cannot be represented by Chat Completions.`)
    }
    if (parsed.kind === 'call') {
      if (callIds.has(parsed.callId)) {
        fail('invalid_function_call_history', `Duplicate function call ID ${parsed.callId}.`)
      }
      callIds.add(parsed.callId)
    }
    result.push(parsed)
  }
  return result
}

function addHistoricalDescriptors(
  items: Array<ParsedInputItem>,
  declared: Map<string, ToolDescriptor>,
): void {
  for (const item of items) {
    if (item.kind !== 'call') {
      continue
    }
    const key = toolKey(item.callKind, item.name, item.namespace)
    const existing = declared.get(key)
    if (existing) {
      continue
    }
    declared.set(key, {
      key,
      type: item.callKind,
      name: item.name,
      namespace: item.namespace,
      parameters: item.callKind === 'custom'
        ? {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
          }
        : { type: 'object', properties: {} },
      current: false,
    })
  }
}

function containsImage(items: Array<ParsedInputItem>): boolean {
  return items.some((item) => {
    if (item.kind === 'message')
      return item.turn.blocks.some(block => block.kind === 'image')
    if (item.kind === 'output')
      return item.content.some(block => block.kind === 'image')
    return false
  })
}

function hasParallelBatch(items: Array<ParsedInputItem>): boolean {
  let consecutiveCalls = 0
  for (const item of items) {
    if (item.kind === 'call') {
      consecutiveCalls++
      if (consecutiveCalls > 1)
        return true
      continue
    }
    consecutiveCalls = 0
  }
  return false
}

function validateModelCapabilities(
  payload: ResponsesPayload,
  model: Model,
  tools: Array<ToolDescriptor>,
  items: Array<ParsedInputItem>,
): void {
  if (model.capabilities.supports.tool_calls !== true
    && (tools.length > 0 || items.some(item => item.kind === 'call' || item.kind === 'output'))) {
    fail('unsupported_tool_calls', `Model ${model.id} does not advertise Chat tool calls.`)
  }
  if (
    model.capabilities.supports.parallel_tool_calls !== true
    && (payload.parallel_tool_calls === true || hasParallelBatch(items))
  ) {
    fail('unsupported_parallel_tool_calls', `Model ${model.id} does not advertise parallel tool calls.`)
  }
  if (payload.stream === true && model.capabilities.supports.streaming === false) {
    fail('unsupported_streaming', `Model ${model.id} does not advertise streaming.`)
  }
  if (model.capabilities.supports.vision !== true && containsImage(items)) {
    fail('unsupported_vision', `Model ${model.id} does not advertise vision input.`)
  }
}

function resolveToolDescriptor(
  name: string,
  namespace: string | undefined,
  preferredType: ToolKind | undefined,
  descriptors: Map<string, ToolDescriptor>,
  currentOnly: boolean,
): ToolDescriptor {
  const candidates = [...descriptors.values()].filter((descriptor) => {
    if (currentOnly && !descriptor.current) {
      return false
    }
    if (descriptor.name !== name) {
      return false
    }
    if (namespace !== undefined && descriptor.namespace !== namespace) {
      return false
    }
    return preferredType === undefined || descriptor.type === preferredType
  })
  if (candidates.length === 0) {
    fail('unsupported_tool_choice', `Tool choice ${namespace ? `${namespace}::` : ''}${name} is not declared.`)
  }
  if (candidates.length > 1) {
    fail('unsupported_namespace', `Tool choice ${name} is ambiguous without a namespace.`)
  }
  return candidates[0]!
}

function resolveToolChoiceDescriptor(
  name: string,
  namespace: string | undefined,
  type: ToolKind,
  descriptors: Map<string, ToolDescriptor>,
  allowApplyPatchGrammar: boolean,
): ToolDescriptor {
  if (type !== 'function' || name !== 'apply_patch' || !allowApplyPatchGrammar) {
    return resolveToolDescriptor(name, namespace, type, descriptors, true)
  }

  const declaredFunction = [...descriptors.values()].some(descriptor =>
    descriptor.current
    && descriptor.type === 'function'
    && descriptor.name === name
    && (namespace === undefined || descriptor.namespace === namespace),
  )
  return resolveToolDescriptor(
    name,
    namespace,
    declaredFunction ? 'function' : 'custom',
    descriptors,
    true,
  )
}

function translateToolChoice(
  choice: ResponsesPayload['tool_choice'],
  descriptors: Map<string, ToolDescriptor>,
  aliases: AliasRegistry,
  allowApplyPatchGrammar: boolean,
): { choice?: ConversationToolChoice, allowedKeys?: Set<string> } {
  if (choice === undefined || choice === null) {
    return {}
  }
  if (typeof choice === 'string') {
    if (choice === 'none' || choice === 'auto' || choice === 'required') {
      return { choice: { type: choice } }
    }
    fail('unsupported_tool_choice', `Tool choice ${choice} is not supported.`)
  }
  if (!isRecord(choice)) {
    fail('unsupported_tool_choice', 'tool_choice must be a supported string or object.')
  }
  assertKnownKeys(choice, TOOL_CHOICE_KEYS, 'tool_choice')
  const type = requiredString(choice.type, 'tool_choice.type')
  if (type === 'function' || type === 'custom') {
    assertKnownKeys(choice, ALLOWED_TOOL_KEYS, 'tool_choice')
    const name = requiredString(choice.name, 'tool_choice.name')
    const namespace = parseNamespace(choice.namespace, 'tool_choice.namespace')
    const descriptor = resolveToolChoiceDescriptor(name, namespace, type, descriptors, allowApplyPatchGrammar)
    return { choice: { type: 'tool', name: aliases.aliasFor(descriptor.key) } }
  }
  if (type === 'allowed_tools') {
    assertKnownKeys(choice, new Set(['type', 'mode', 'tools']), 'tool_choice')
    const mode = requiredString(choice.mode, 'tool_choice.mode')
    if (mode !== 'auto' && mode !== 'required') {
      fail('unsupported_tool_choice', 'allowed_tools.mode must be auto or required.')
    }
    if (!Array.isArray(choice.tools) || choice.tools.length === 0) {
      fail('unsupported_tool_choice', 'allowed_tools.tools must contain at least one function or custom tool.')
    }
    const allowedKeys = new Set<string>()
    for (const [index, rawAllowed] of choice.tools.entries()) {
      if (!isRecord(rawAllowed)) {
        fail('unsupported_tool_choice', `tool_choice.tools[${index}] must be an object.`)
      }
      assertKnownKeys(rawAllowed, ALLOWED_TOOL_KEYS, `tool_choice.tools[${index}]`)
      const allowedType = requiredString(rawAllowed.type, `tool_choice.tools[${index}].type`)
      if (allowedType !== 'function' && allowedType !== 'custom') {
        fail('unsupported_tool_choice', `allowed_tools cannot select hosted tool type ${allowedType}.`)
      }
      const allowedName = requiredString(rawAllowed.name, `tool_choice.tools[${index}].name`)
      const allowedNamespace = parseNamespace(rawAllowed.namespace, `tool_choice.tools[${index}].namespace`)
      const descriptor = resolveToolChoiceDescriptor(
        allowedName,
        allowedNamespace,
        allowedType,
        descriptors,
        allowApplyPatchGrammar,
      )
      allowedKeys.add(descriptor.key)
    }
    return { choice: { type: mode }, allowedKeys }
  }
  if (type === 'apply_patch') {
    assertKnownKeys(choice, new Set(['type']), 'tool_choice')
    const descriptor = resolveToolDescriptor('apply_patch', undefined, 'custom', descriptors, true)
    return { choice: { type: 'tool', name: aliases.aliasFor(descriptor.key) } }
  }
  fail('unsupported_tool_choice', `Hosted tool choice ${type} cannot be represented by Chat Completions.`)
}

function toConversationTools(
  ordered: Array<ToolDescriptor>,
  aliases: AliasRegistry,
  allowedKeys?: Set<string>,
): Array<ConversationTool> {
  return ordered
    .filter(descriptor => !allowedKeys || allowedKeys.has(descriptor.key))
    .map(descriptor => ({
      name: aliases.aliasFor(descriptor.key),
      ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
      inputSchema: descriptor.parameters,
    }))
}

function buildTurns(
  instructions: ResponsesPayload['instructions'],
  items: Array<ParsedInputItem>,
  aliases: AliasRegistry,
  descriptors: Map<string, ToolDescriptor>,
): Array<ConversationTurn> {
  const turns: Array<ConversationTurn> = []
  if (instructions !== undefined && instructions !== null) {
    turns.push({ role: 'system', blocks: [{ kind: 'text', text: instructions }] })
  }

  const unresolved = new Map<string, ParsedCallItem>()
  const pendingCalls: Array<ParsedCallItem> = []
  const resolved = new Set<string>()
  const flushCalls = () => {
    if (pendingCalls.length === 0) {
      return
    }
    turns.push({
      role: 'assistant',
      blocks: pendingCalls.map((call): ConversationBlock => ({
        kind: 'tool_use',
        id: call.callId,
        name: aliases.aliasFor(toolKey(call.callKind, call.name, call.namespace)),
        input: call.input,
        argumentsText: call.argumentsText,
      })),
    })
    pendingCalls.length = 0
  }

  for (const item of items) {
    if (item.kind === 'message') {
      if (unresolved.size > 0) {
        fail('invalid_function_call_history', 'A message appeared before all parallel tool calls were resolved.')
      }
      flushCalls()
      turns.push(item.turn)
      continue
    }
    if (item.kind === 'call') {
      if (unresolved.size > 0 && pendingCalls.length === 0) {
        fail('invalid_function_call_history', 'A new tool call appeared before the prior parallel batch was resolved.')
      }
      const key = toolKey(item.callKind, item.name, item.namespace)
      if (!descriptors.has(key)) {
        fail('invalid_function_call_history', `Tool call ${item.name} has no resolvable descriptor.`)
      }
      unresolved.set(item.callId, item)
      pendingCalls.push(item)
      continue
    }

    flushCalls()
    const call = unresolved.get(item.callId)
    if (!call) {
      fail('invalid_function_call_history', `Tool output ${item.callId} has no matching function call.`)
    }
    if (resolved.has(item.callId)) {
      fail('invalid_function_call_history', `Tool output ${item.callId} was provided more than once.`)
    }
    if (call.callKind !== item.outputKind) {
      fail('invalid_function_call_history', `Tool output ${item.callId} does not match its call type.`)
    }
    if (item.namespace !== undefined && item.namespace !== call.namespace) {
      fail('unsupported_namespace', `Tool output ${item.callId} used a different namespace than its call.`)
    }
    if (item.name !== undefined && item.name !== call.name) {
      fail('invalid_function_call_history', `Tool output ${item.callId} used a different tool name than its call.`)
    }
    turns.push({
      // The CAPI plan builder serializes tool results from a user turn. A
      // ConversationTurn with role=tool would silently discard the result.
      role: 'user',
      blocks: [{ kind: 'tool_result', toolUseId: item.callId, content: item.content }],
      meta: { toolCallId: item.callId },
    })
    unresolved.delete(item.callId)
    resolved.add(item.callId)
  }

  if (unresolved.size > 0) {
    fail('invalid_function_call_history', 'The request ended with unresolved function calls.')
  }
  flushCalls()
  return turns
}

function validatePayloadIntent(
  payload: ResponsesPayload,
  context: TranslationContext,
): void {
  assertKnownKeys(payload, PAYLOAD_KEYS, 'payload')
  if (payload.background) {
    fail('unsupported_background', 'background=true is not supported by the Chat bridge.')
  }
  if (payload.conversation || payload.previous_response_id) {
    fail('unsupported_responses_state', 'conversation and previous_response_id must be resolved by the local emulator before Chat translation.')
  }
  if (payload.store) {
    fail('unsupported_responses_state', 'store=true requires the local Responses emulator and is not sent to Chat.')
  }
  if (payload.prompt) {
    fail('unsupported_prompt', 'Server-side prompt templates are not resolved by the Chat bridge.')
  }
  if (payload.max_tool_calls !== undefined && payload.max_tool_calls !== null) {
    fail('unsupported_max_tool_calls', 'max_tool_calls has no Chat Completions equivalent.')
  }
  if (payload.safety_identifier !== undefined && payload.safety_identifier !== null) {
    fail('unsupported_safety_identifier', 'safety_identifier has no safe Chat Completions equivalent.')
  }
  if (payload.prompt_cache_options !== undefined && payload.prompt_cache_options !== null) {
    fail('unsupported_prompt_cache_options', 'prompt_cache_options cannot be guaranteed through Chat Completions.')
  }
  if (payload.prompt_cache_retention !== undefined && payload.prompt_cache_retention !== null) {
    fail('unsupported_prompt_cache_retention', 'prompt_cache_retention cannot be guaranteed through Chat Completions.')
  }
  if (payload.truncation === 'auto') {
    fail('unsupported_truncation', 'truncation=auto cannot be represented through Chat Completions.')
  }
  if (payload.context_management !== undefined && payload.context_management !== null && payload.context_management.length > 0) {
    fail('unsupported_responses_compaction', 'context_management cannot be represented through Chat Completions.')
  }
  if (payload.service_tier !== undefined && payload.service_tier !== null) {
    fail('unsupported_service_tier', 'service_tier has no safe Chat Completions mapping.')
  }
  if (payload.client_metadata !== undefined && payload.client_metadata !== null) {
    recordIssue(context, 'lossy_client_metadata_omitted', 'client_metadata was treated as a harmless hint and omitted from Chat.')
  }
  if (payload.prompt_cache_key !== undefined && payload.prompt_cache_key !== null) {
    recordIssue(context, 'lossy_prompt_cache_key', 'prompt_cache_key was accepted as advisory metadata and omitted from Chat.')
  }
  if (payload.stream_options !== undefined && payload.stream_options !== null) {
    assertKnownKeys(payload.stream_options, STREAM_OPTIONS_KEYS, 'stream_options')
    if (payload.stream_options.include_obfuscation !== undefined && payload.stream_options.include_obfuscation !== null) {
      recordIssue(context, 'lossy_stream_obfuscation', 'stream_options.include_obfuscation is not representable through Chat.')
    }
  }
  if (payload.reasoning !== undefined && payload.reasoning !== null) {
    assertKnownKeys(payload.reasoning, REASONING_CONFIG_KEYS, 'reasoning')
    if (payload.reasoning.summary !== undefined && payload.reasoning.summary !== null) {
      recordIssue(context, 'lossy_reasoning_summary', 'reasoning.summary is advisory and has no Chat equivalent.')
    }
    if (payload.reasoning.generate_summary !== undefined && payload.reasoning.generate_summary !== null) {
      recordIssue(context, 'lossy_reasoning_summary', 'reasoning.generate_summary is advisory and has no Chat equivalent.')
    }
  }
  if (payload.include !== undefined && payload.include !== null) {
    for (const include of payload.include) {
      if (include === 'reasoning.encrypted_content') {
        recordIssue(context, 'lossy_reasoning_include', 'include=reasoning.encrypted_content is advisory and cannot be emitted by Chat.')
      }
      else {
        fail('unsupported_include', `include=${include} cannot be represented through Chat Completions.`)
      }
    }
  }
  if (payload.text !== undefined && payload.text !== null) {
    if (!isRecord(payload.text)) {
      fail('unsupported_responses_field', 'text must be an object when provided.')
    }
    const text = payload.text
    assertKnownKeys(text, TEXT_KEYS, 'text')
    if (text.verbosity !== undefined && text.verbosity !== null) {
      recordIssue(context, 'lossy_text_verbosity', 'text.verbosity is advisory and was omitted from Chat.')
    }
  }
}

function responseFormatFor(
  payload: ResponsesPayload,
  model: Model,
): CapiResponseFormat | undefined {
  const rawText = payload.text
  if (rawText === undefined || rawText === null || rawText.format === undefined || rawText.format === null) {
    return undefined
  }
  if (!isRecord(rawText.format)) {
    fail('unsupported_structured_output', 'text.format must be an object when provided.')
  }
  const format = rawText.format
  const type = requiredString(format.type, 'text.format.type')
  assertKnownKeys(format, type === 'json_schema' ? JSON_SCHEMA_KEYS : SIMPLE_FORMAT_KEYS, 'text.format')
  if (type === 'text') {
    return undefined
  }
  if (type === 'json_object') {
    return { type: 'json_object' }
  }
  if (type !== 'json_schema') {
    fail('unsupported_structured_output', `text.format.type=${type} is not supported by Chat.`)
  }
  if (model.capabilities.supports.structured_outputs !== true) {
    fail('unsupported_structured_output', `JSON Schema output is not advertised by model ${model.id}.`)
  }
  const name = requiredString(format.name, 'text.format.name')
  const schema = format.schema
  if (!isRecord(schema)) {
    fail('unsupported_structured_output', 'text.format.schema must be a JSON object.')
  }
  const descriptionValue = format.description ?? undefined
  const description = descriptionValue === undefined
    ? undefined
    : requiredText(descriptionValue, 'text.format.description')
  const strict = format.strict ?? undefined
  if (strict !== undefined && typeof strict !== 'boolean') {
    fail('unsupported_structured_output', 'text.format.strict must be boolean when provided.')
  }
  return {
    type: 'json_schema',
    json_schema: {
      name,
      schema,
      ...(description !== undefined ? { description } : {}),
      ...(strict !== undefined ? { strict } : {}),
    },
  }
}

function addCapiOnlyFields(
  plan: CapiExecutionPlan,
  payload: ResponsesPayload,
  model: Model,
  responseFormat: CapiResponseFormat | undefined,
  reasoningEffort: string | undefined,
): void {
  const capi = plan.payload
  if (payload.parallel_tool_calls !== undefined && payload.parallel_tool_calls !== null) {
    capi.parallel_tool_calls = payload.parallel_tool_calls
    plan.tokenCountPayload.parallel_tool_calls = payload.parallel_tool_calls
  }
  const topK = payload.top_k
  if (topK !== undefined && topK !== null) {
    capi.top_k = typeof topK === 'number' ? topK : fail('invalid_responses_field', 'top_k must be numeric.')
    plan.tokenCountPayload.top_k = capi.top_k
  }
  if (responseFormat !== undefined) {
    capi.response_format = responseFormat
    plan.tokenCountPayload.response_format = responseFormat
  }
  if (reasoningEffort !== undefined) {
    capi.reasoning_effort = reasoningEffort as CapiChatCompletionsPayload['reasoning_effort']
    plan.tokenCountPayload.reasoning_effort = reasoningEffort as CapiChatCompletionsPayload['reasoning_effort']
  }
  applyChatCompletionsTokenParam(capi, model)
  applyChatCompletionsTokenParam(plan.tokenCountPayload, model)
}

function applyStrictToPlan(
  plan: CapiExecutionPlan,
  descriptors: Array<ToolDescriptor>,
  aliases: AliasRegistry,
): void {
  const strictByAlias = new Map<string, boolean>()
  for (const descriptor of descriptors) {
    if (descriptor.strict !== undefined) {
      strictByAlias.set(aliases.aliasFor(descriptor.key), descriptor.strict)
    }
  }
  const patchTools = (tools: Array<CapiToolWithStrict> | null | undefined): Array<CapiToolWithStrict> | null | undefined => {
    if (!tools) {
      return tools
    }
    return tools.map((tool) => {
      const strict = strictByAlias.get(tool.function.name)
      return strict === undefined
        ? tool
        : { ...tool, function: { ...tool.function, strict } }
    })
  }
  plan.payload.tools = patchTools(plan.payload.tools)
  plan.tokenCountPayload.tools = patchTools(plan.tokenCountPayload.tools)
}

export function translateResponsesToChat(
  payload: ResponsesPayload,
  model: Model,
  options: ResponsesToChatOptions = {},
): ResponsesChatRequest {
  const context = new TranslationContext()
  validatePayloadIntent(payload, context)
  const parsedTools = parseToolDeclarations(
    payload,
    model,
    context,
    options.allowApplyPatchGrammar ?? false,
  )
  const parsedItems = parseInputItems(payload, parsedTools.byKey, context)
  addHistoricalDescriptors(parsedItems, parsedTools.byKey)
  validateModelCapabilities(payload, model, parsedTools.ordered, parsedItems)
  const aliases = createAliasRegistry(parsedTools.byKey)
  const toolChoice = translateToolChoice(
    payload.tool_choice,
    parsedTools.byKey,
    aliases,
    options.allowApplyPatchGrammar ?? false,
  )
  const turns = buildTurns(payload.instructions, parsedItems, aliases, parsedTools.byKey)
  const effort = payload.reasoning?.effort ?? undefined
  if (effort) {
    const advertised = model.capabilities.supports.reasoning_effort
    if (!advertised?.includes(effort)) {
      fail('unsupported_reasoning_effort', `reasoning.effort=${effort} is not advertised by model ${model.id}.`)
    }
  }
  const responseFormat = responseFormatFor(payload, model)
  const conversation: ConversationRequest = {
    model: model.id,
    turns,
    maxTokens: Object.hasOwn(payload, 'max_output_tokens')
      ? (payload.max_output_tokens ?? undefined)
      : model.capabilities.limits.max_output_tokens,
    stream: payload.stream ?? undefined,
    temperature: payload.temperature,
    topP: payload.top_p,
    userId: payload.user ?? undefined,
    tools: toConversationTools(parsedTools.ordered, aliases, toolChoice.allowedKeys),
    toolChoice: toolChoice.choice,
  }
  if (effort && effort !== 'none' && effort !== 'minimal') {
    conversation.outputEffort = effort as NonNullable<ConversationRequest['outputEffort']>
  }

  const plan = buildCapiExecutionPlan(conversation, {
    resolveModel: () => model.id,
    requestContext: options.requestContext,
  })
  applyStrictToPlan(
    plan,
    parsedTools.ordered.filter(descriptor => !toolChoice.allowedKeys || toolChoice.allowedKeys.has(descriptor.key)),
    aliases,
  )
  addCapiOnlyFields(plan, payload, model, responseFormat, effort)
  return {
    plan,
    toolMap: new Map<string, ResponsesChatTool>(aliases.entries()
      .filter(([, descriptor]) => descriptor.current && (!toolChoice.allowedKeys || toolChoice.allowedKeys.has(descriptor.key)))
      .map(([, descriptor]) => [
        aliases.aliasFor(descriptor.key),
        {
          type: descriptor.type,
          name: descriptor.name,
          ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}),
        },
      ])),
    issues: context.getIssues() as Array<TranslationIssue>,
  }
}
