const COMPACTION_PREFIX = 'cm1#'
const SEPARATOR = '@'

interface CompactionCarrier {
  id: string
  encrypted_content: string
}

function encodeCompaction(carrier: CompactionCarrier): string {
  return `${COMPACTION_PREFIX}${carrier.encrypted_content}${SEPARATOR}${carrier.id}`
}

function decodeCompaction(signature: string): CompactionCarrier | undefined {
  if (!signature.startsWith(COMPACTION_PREFIX)) {
    return undefined
  }

  const raw = signature.slice(COMPACTION_PREFIX.length)
  const separatorIndex = raw.indexOf(SEPARATOR)
  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
    return undefined
  }

  const encrypted_content = raw.slice(0, separatorIndex)
  const id = raw.slice(separatorIndex + 1)
  if (!encrypted_content) {
    return undefined
  }

  return { id, encrypted_content }
}

function encodeReasoning(item: { id: string, encrypted_content?: string | null }): string {
  return `${item.encrypted_content ?? ''}${SEPARATOR}${item.id}`
}

function decodeReasoning(signature: string): { encryptedContent: string, id: string } {
  const splitIndex = signature.lastIndexOf(SEPARATOR)
  if (splitIndex <= 0 || splitIndex === signature.length - 1) {
    return { encryptedContent: signature, id: '' }
  }
  return {
    encryptedContent: signature.slice(0, splitIndex),
    id: signature.slice(splitIndex + 1),
  }
}

function isCompactionSignature(signature: string): boolean {
  return signature.startsWith(COMPACTION_PREFIX)
}

function isReasoningSignature(signature: string): boolean {
  return !isCompactionSignature(signature) && signature.includes(SEPARATOR)
}

export const SignatureCodec = {
  encodeCompaction,
  decodeCompaction,
  encodeReasoning,
  decodeReasoning,
  isCompactionSignature,
  isReasoningSignature,
} as const

export type { CompactionCarrier }
