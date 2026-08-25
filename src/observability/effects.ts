import type { ModelTransformTag } from '~/lib/request-logger'

export const PROXY_EFFECT_DEFINITIONS = {
  'model.auto_correct': {
    category: 'Model routing',
    label: 'Model ID auto-corrected',
  },
  'model.config_rewrite': {
    category: 'Model routing',
    label: 'Configured model rewrite applied',
  },
  'model.compact_route': {
    category: 'Model routing',
    label: 'Compact request routed to small model',
  },
  'model.family_fallback': {
    category: 'Model routing',
    label: 'Model family fallback resolved',
  },
  'model.overload_fallback': {
    category: 'Recovery',
    label: 'Overload fallback selected',
  },
  'strategy.chat_completions': {
    category: 'Strategy',
    label: 'Chat Completions strategy selected',
  },
  'strategy.native_messages': {
    category: 'Strategy',
    label: 'Native Messages strategy selected',
  },
  'strategy.responses_passthrough': {
    category: 'Strategy',
    label: 'Responses passthrough selected',
  },
  'strategy.responses_translation': {
    category: 'Strategy',
    label: 'Messages translated through Responses',
  },
  'strategy.chat_fallback': {
    category: 'Strategy',
    label: 'Messages translated through Chat Completions',
  },
  'chat.max_tokens_defaulted': {
    category: 'Parameters',
    label: 'Chat output token limit defaulted',
  },
  'chat.max_tokens_renamed': {
    category: 'Parameters',
    label: 'max_tokens renamed for upstream compatibility',
  },
  'messages.thinking_adapted': {
    category: 'Reasoning',
    label: 'Classic thinking converted to adaptive thinking',
  },
  'messages.thinking_blocks_filtered': {
    category: 'Reasoning',
    label: 'Incompatible thinking blocks filtered',
  },
  'messages.output_config_sanitized': {
    category: 'Output',
    label: 'Messages output_config corrected',
  },
  'messages.output_format_reduced': {
    category: 'Output',
    label: 'Messages output format reduced to upstream shape',
  },
  'messages.sampling_filtered': {
    category: 'Parameters',
    label: 'Exclusive sampling parameter filtered',
  },
  'messages.cache_control_sanitized': {
    category: 'Parameters',
    label: 'Cache control metadata sanitized',
  },
  'messages.output_tokens_lowered': {
    category: 'Output',
    label: 'Messages output token limit lowered',
  },
  'responses.function_apply_patch': {
    category: 'Tools',
    label: 'apply_patch converted to a function tool',
  },
  'responses.function_schema_normalized': {
    category: 'Tools',
    label: 'Function tool schema normalized',
  },
  'responses.store_disabled': {
    category: 'Input',
    label: 'Responses persistence disabled',
  },
  'responses.input_items_filtered': {
    category: 'Input',
    label: 'Unresolvable input items filtered',
  },
  'responses.phase_filtered': {
    category: 'Input',
    label: 'Unsupported message phase filtered',
  },
  'responses.input_compacted': {
    category: 'Context',
    label: 'Input trimmed to latest compaction item',
  },
  'responses.context_management': {
    category: 'Context',
    label: 'Context management injected',
  },
  'responses.parameter_filter': {
    category: 'Parameters',
    label: 'Unsupported Responses parameters filtered',
  },
  'responses.output_tokens_raised': {
    category: 'Output',
    label: 'Responses output token floor applied',
  },
  'responses.reasoning_effort_lowered': {
    category: 'Reasoning',
    label: 'Reasoning effort lowered to advertised support',
  },
  'recovery.queued': {
    category: 'Recovery',
    label: 'Request waited in the upstream queue',
  },
  'recovery.retry': {
    category: 'Recovery',
    label: 'Upstream request retried',
  },
  'recovery.cooldown': {
    category: 'Recovery',
    label: 'Capacity cooldown applied',
  },
  'recovery.budget_exhausted': {
    category: 'Recovery',
    label: 'Recovery budget exhausted',
  },
} as const

export type ProxyEffectId = keyof typeof PROXY_EFFECT_DEFINITIONS

export function effectForModelTransform(tag: ModelTransformTag): ProxyEffectId | undefined {
  switch (tag) {
    case 'AUTO_CORRECT':
      return 'model.auto_correct'
    case 'CONFIG_REWRITE':
      return 'model.config_rewrite'
    case 'COMPACT':
      return 'model.compact_route'
    case 'MODEL_RESOLVE':
      return 'model.family_fallback'
    case 'OVERLOAD_FALLBACK':
      return 'model.overload_fallback'
    default:
      return undefined
  }
}

export function effectForStrategy(
  protocol: string,
  strategy: string,
): ProxyEffectId | undefined {
  if (protocol === 'anthropic-messages') {
    if (strategy === 'native-messages')
      return 'strategy.native_messages'
    if (strategy === 'responses-api')
      return 'strategy.responses_translation'
    if (strategy === 'chat-completions')
      return 'strategy.chat_fallback'
  }
  if (protocol === 'responses' && strategy === 'responses-passthrough')
    return 'strategy.responses_passthrough'
  if (protocol === 'openai-chat' && strategy === 'chat-completions')
    return 'strategy.chat_completions'
  return undefined
}
