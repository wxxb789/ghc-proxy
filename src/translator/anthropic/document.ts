import type { AnthropicDocumentBlock } from './types'

/**
 * Flatten an Anthropic `document` content block to plain text for translation
 * paths (Responses / Chat Completions) and for the native mixed-search-result
 * flatten path. Anthropic allows `document` blocks inside `tool_result.content`
 * alongside `text`, `image`, and `search_result`.
 */
export function formatDocumentBlock(block: AnthropicDocumentBlock): string {
  const source = block.source

  if (source.type === 'text' && typeof source.data === 'string') {
    const text = source.data.trim()
    return text ? `[document]\n${text}` : '[document]'
  }

  if (source.type === 'content' && Array.isArray(source.content)) {
    const text = source.content
      .map(part =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text.trim()
          : '',
      )
      .filter(Boolean)
      .join('\n')
    return text ? `[document]\n${text}` : '[document]'
  }

  return '[document]'
}
