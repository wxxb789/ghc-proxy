import type {
  ResponseCompletedEvent,
  ResponseCreatedEvent,
  ResponseErrorEvent,
  ResponseFailedEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseFunctionCallArgumentsDoneEvent,
  ResponseIncompleteEvent,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseReasoningSummaryTextDeltaEvent,
  ResponseReasoningSummaryTextDoneEvent,
  ResponsesResult,
  ResponseStreamEvent,
  ResponseTextDeltaEvent,
  ResponseTextDoneEvent,
} from '~/types'

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

export type KnownResponseStreamEvent
  = | ResponseCompletedEvent
    | ResponseCreatedEvent
    | ResponseErrorEvent
    | ResponseFailedEvent
    | ResponseFunctionCallArgumentsDeltaEvent
    | ResponseFunctionCallArgumentsDoneEvent
    | ResponseIncompleteEvent
    | ResponseOutputItemAddedEvent
    | ResponseOutputItemDoneEvent
    | ResponseReasoningSummaryTextDeltaEvent
    | ResponseReasoningSummaryTextDoneEvent
    | ResponseTextDeltaEvent
    | ResponseTextDoneEvent
    | ResponseStreamEvent

export type { ResponsesResult }
