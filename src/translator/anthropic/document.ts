import type { AnthropicDocumentBlock } from './types'

/** Trimmed text of a `content`-source document part, or undefined when it carries none. */
function documentPartText(part: unknown): string | undefined {
  if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
    return (part as { text: string }).text.trim() || undefined
  }
  return undefined
}

/** A short reference identifying a non-text document source, or '' when none is available. */
function documentSourceRef(source: Record<string, unknown>): string {
  if (typeof source.url === 'string') {
    return `: ${source.url}`
  }
  if (typeof source.file_id === 'string') {
    return `: ${source.file_id}`
  }
  if (typeof source.media_type === 'string') {
    return `: ${source.media_type}`
  }
  return ''
}

/**
 * Flatten an Anthropic `document` content block to plain text for translation
 * paths that cannot carry an attachment (Chat Completions, and the native
 * mixed-search-result flatten path). Text and content sources inline their
 * text; file/url/base64 sources have no text to inline, so they degrade to a
 * reference-labelled placeholder (mirroring `[image omitted: <media_type>]`)
 * rather than a content-free token. Anthropic allows `document` blocks inside
 * `tool_result.content` alongside `text`, `image`, and `search_result`.
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

  return `[document${documentSourceRef(source)}]`
}
