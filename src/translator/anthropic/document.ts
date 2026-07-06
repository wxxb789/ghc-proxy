import type { AnthropicDocumentBlock } from './types'

/** Trimmed text of a `content`-source document part, or undefined when it carries none. */
function documentPartText(part: unknown): string | undefined {
  if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
    return (part as { text: string }).text.trim() || undefined
  }
  return undefined
}

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
    const parts: Array<string> = []
    for (const part of source.content) {
      const text = documentPartText(part)
      if (text) {
        parts.push(text)
      }
    }
    return parts.length ? `[document]\n${parts.join('\n')}` : '[document]'
  }

  return '[document]'
}
