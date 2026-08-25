import type {
  AnthropicCountTokensPayload,
  AnthropicMessagesPayload,
} from '~/translator'

import { z } from 'zod'
import { isAnthropicBuiltinTool } from '~/translator'

import {
  createObjectSchemaDefinitionSchema,
  jsonObjectSchema,
  parsePayload,
} from './shared'

// ── Schema Definitions ──

const anthropicTextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).loose()

const anthropicImageBlockSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.literal('base64'),
    media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    data: z.string().min(1),
  }).loose(),
}).loose()

const anthropicSearchResultBlockSchema = z.object({
  type: z.literal('search_result'),
  source: z.string().min(1),
  title: z.string().min(1),
  content: z.array(anthropicTextBlockSchema).min(1),
  citations: z.unknown().optional(),
  cache_control: z.unknown().optional(),
}).loose()

const anthropicThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
}).loose()

const anthropicRedactedThinkingBlockSchema = z.object({
  type: z.literal('redacted_thinking'),
  data: z.string(),
}).loose()

const anthropicToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: jsonObjectSchema,
}).loose()

const anthropicServerToolUseBlockSchema = z.object({
  type: z.literal('server_tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: jsonObjectSchema,
}).loose()

const anthropicMcpToolUseBlockSchema = z.object({
  type: z.literal('mcp_tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: jsonObjectSchema,
  server_name: z.string().min(1),
}).loose()

const anthropicDocumentBlockSchema = z.object({
  type: z.literal('document'),
  source: jsonObjectSchema,
}).loose()

const anthropicToolResultContentBlockSchema = z.union([
  anthropicTextBlockSchema,
  anthropicImageBlockSchema,
  anthropicSearchResultBlockSchema,
  anthropicDocumentBlockSchema,
])

const anthropicToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  content: z.union([
    z.string(),
    z.array(anthropicToolResultContentBlockSchema),
  ]),
  is_error: z.boolean().optional(),
}).loose()

const anthropicMcpToolResultBlockSchema = z.object({
  type: z.literal('mcp_tool_result'),
  tool_use_id: z.string().min(1),
  content: z.union([
    z.string(),
    z.array(anthropicToolResultContentBlockSchema),
  ]),
  is_error: z.boolean().optional(),
}).loose()

const anthropicServerToolResultBlockSchema = z.object({
  type: z.enum([
    'server_tool_result',
    'web_search_tool_result',
    'web_fetch_tool_result',
    'code_execution_tool_result',
    'bash_code_execution_tool_result',
    'text_editor_code_execution_tool_result',
    'tool_search_tool_result',
  ]),
  tool_use_id: z.string().min(1),
  content: z.unknown(),
  is_error: z.boolean().optional(),
}).loose()

const anthropicUserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([
    z.string(),
    z.array(z.union([
      anthropicTextBlockSchema,
      anthropicImageBlockSchema,
      anthropicSearchResultBlockSchema,
      anthropicToolResultBlockSchema,
      anthropicMcpToolResultBlockSchema,
      anthropicServerToolResultBlockSchema,
      anthropicDocumentBlockSchema,
    ])),
  ]),
}).loose()

const anthropicAssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([
    z.string(),
    z.array(z.union([
      anthropicTextBlockSchema,
      anthropicThinkingBlockSchema,
      anthropicRedactedThinkingBlockSchema,
      anthropicToolUseBlockSchema,
      anthropicServerToolUseBlockSchema,
      anthropicMcpToolUseBlockSchema,
      anthropicMcpToolResultBlockSchema,
      anthropicServerToolResultBlockSchema,
    ])),
  ]),
}).loose()

const anthropicSystemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.union([
    z.string(),
    z.array(anthropicTextBlockSchema),
  ]),
}).loose()

const anthropicMessageSchema = z.union([
  anthropicUserMessageSchema,
  anthropicAssistantMessageSchema,
  anthropicSystemMessageSchema,
])

const anthropicToolSchema = z.object({
  type: z.string().min(1).nullable().optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  input_schema: createObjectSchemaDefinitionSchema('tool input_schema must describe an object').optional(),
}).loose().superRefine((tool, ctx) => {
  const isBuiltinTool = isAnthropicBuiltinTool(tool)
  if (!isBuiltinTool && tool.input_schema === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'tool input_schema must describe an object',
      path: ['input_schema'],
    })
  }
  if (!isBuiltinTool && tool.name === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'function tools require a name',
      path: ['name'],
    })
  }
})

const anthropicToolChoiceSchema = z.union([
  z.object({
    type: z.literal('auto'),
  }).loose(),
  z.object({
    type: z.literal('any'),
  }).loose(),
  z.object({
    type: z.literal('none'),
  }).loose(),
  z.object({
    type: z.literal('tool'),
    name: z.string().min(1),
  }).loose(),
])

const anthropicThinkingSchema = z.union([
  z.object({
    type: z.literal('disabled'),
  }).loose(),
  z.object({
    type: z.literal('adaptive'),
  }).loose(),
  z.object({
    type: z.literal('enabled'),
    budget_tokens: z.number().int().positive(),
  }).loose(),
])

/**
 * `format` stays strict: an unrecognized key here means the caller expects a
 * constraint the proxy cannot translate, and silently accepting it would let a
 * schema-constrained request come back unconstrained. Rejecting is the honest
 * answer — see docs/solutions/integration-issues/claude-code-messages-startup-payloads.md.
 */
const anthropicOutputFormatSchema = z.object({
  type: z.literal('json_schema'),
  schema: jsonObjectSchema,
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  strict: z.boolean().optional(),
}).strict()

/**
 * `output_config` itself is loose. It is the fastest-moving object in the
 * Anthropic Messages schema, and it was the only strict container on this
 * boundary — so every field Anthropic added arrived here as a local 400 before
 * the request could reach a model that may well accept it. Unknown keys are
 * forwarded rather than rejected; `format` keeps its own strict contract above,
 * and `sanitizeOutputConfig` preserves the extras rather than dropping them.
 */
const anthropicOutputConfigSchema = z.object({
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
  format: anthropicOutputFormatSchema.optional(),
}).loose()

const anthropicMessagesBasePayloadSchema = z.object({
  model: z.string().min(1),
  messages: z.array(anthropicMessageSchema).min(1),
  system: z.union([
    z.string(),
    z.array(anthropicTextBlockSchema),
  ]).optional(),
  metadata: z.object({
    user_id: z.string().optional(),
  }).loose().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().positive().optional(),
  tools: z.array(anthropicToolSchema).optional(),
  tool_choice: anthropicToolChoiceSchema.optional(),
  thinking: anthropicThinkingSchema.optional(),
  output_config: anthropicOutputConfigSchema.optional(),
  service_tier: z.enum(['auto', 'standard_only']).optional(),
}).loose().superRefine((payload, ctx) => {
  if (payload.tool_choice?.type === 'tool' && !payload.tools?.some(tool => tool.name === payload.tool_choice?.name)) {
    ctx.addIssue({
      code: 'custom',
      message: 'tool_choice.name must reference a declared tool',
      path: ['tool_choice', 'name'],
    })
  }
})

const anthropicMessagesPayloadSchema = anthropicMessagesBasePayloadSchema.extend({
  max_tokens: z.number().int().nonnegative(),
})

const anthropicCountTokensPayloadSchema = anthropicMessagesBasePayloadSchema.extend({
  max_tokens: z.number().int().nonnegative().optional(),
})

// ── Parse Functions ──

export function parseAnthropicMessagesPayload(payload: unknown): AnthropicMessagesPayload {
  return parsePayload(anthropicMessagesPayloadSchema, 'anthropic.messages', payload) as AnthropicMessagesPayload
}

export function parseAnthropicCountTokensPayload(payload: unknown): AnthropicCountTokensPayload {
  return parsePayload(anthropicCountTokensPayloadSchema, 'anthropic.messages.count_tokens', payload) as AnthropicCountTokensPayload
}
