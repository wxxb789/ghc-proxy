export interface FunctionCallStreamState {
  blockIndex: number
  toolCallId: string
  name: string
  consecutiveWhitespaceCount: number
  started: boolean
  closed: boolean
}

export interface ResponsesStreamState {
  messageStartSent: boolean
  messageCompleted: boolean
  nextContentBlockIndex: number
  activeScalarBlockKey: string | null
  activeScalarBlockIndex: number | null
  blockHasDelta: Set<number>
  functionCallStateByOutputIndex: Map<number, FunctionCallStreamState>
}
