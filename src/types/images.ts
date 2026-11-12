export type ImageReference = (
  | { image_url: string, file_id?: never }
  | { file_id: string, image_url?: never }
) & Record<string, unknown>

export interface ImageGenerationRequest {
  model: string
  prompt: string
  stream?: boolean | null
  [key: string]: unknown
}

export interface ImageEditJsonRequest {
  images: ImageReference[]
  prompt: string
  model?: string | null
  mask?: ImageReference | null
  stream?: boolean | null
  [key: string]: unknown
}

export type ImageEditRequest = ImageEditJsonRequest | FormData

export interface ImageStreamChunk {
  id?: number | string
  event?: string
  data?: string
}

export interface ImageResponse {
  created?: number
  data?: Array<{
    b64_json?: string
    url?: string
    revised_prompt?: string
    [key: string]: unknown
  }>
  usage?: Record<string, unknown>
  [key: string]: unknown
}
