import type { ImageEditJsonRequest, ImageGenerationRequest } from '~/types'

import { z } from 'zod'

import { throwInvalidRequestError } from '~/lib/error'

import { parsePayload } from './shared'

const imageReferenceSchema = z.object({
  image_url: z.string().min(1).optional(),
  file_id: z.string().min(1).optional(),
}).loose().refine(
  reference => (reference.image_url !== undefined) !== (reference.file_id !== undefined),
  'Provide exactly one of image_url or file_id.',
)

const imageOptions = {
  prompt: z.string().min(1),
  stream: z.boolean().nullable().optional(),
  size: z.string().nullable().optional(),
  quality: z.string().nullable().optional(),
  n: z.number().int().nullable().optional(),
  background: z.string().nullable().optional(),
  output_format: z.string().nullable().optional(),
  output_compression: z.number().int().nullable().optional(),
  moderation: z.string().nullable().optional(),
  partial_images: z.number().int().nullable().optional(),
  response_format: z.string().nullable().optional(),
  user: z.string().nullable().optional(),
}

const imageGenerationSchema = z.object({
  ...imageOptions,
  model: z.string().min(1),
}).loose()

const imageEditSchema = z.object({
  ...imageOptions,
  model: z.string().min(1).nullable().optional(),
  images: z.array(imageReferenceSchema).min(1),
  mask: imageReferenceSchema.nullable().optional(),
}).loose()

export function parseImageGenerationRequest(payload: unknown): ImageGenerationRequest {
  return parsePayload(imageGenerationSchema, 'openai.images.generations', payload)
}

export function parseImageEditRequest(payload: unknown): ImageEditJsonRequest {
  return parsePayload(imageEditSchema, 'openai.images.edits', payload) as ImageEditJsonRequest
}

const multipartTextFields = new Set([...Object.keys(imageOptions), 'model'])

export function parseImageEditFormData(payload: FormData): FormData {
  let hasImage = false
  let hasPrompt = false
  let modelCount = 0
  let streamCount = 0

  payload.forEach((value, field) => {
    if (field === 'image' || field === 'image[]' || field === 'mask') {
      if (typeof value === 'string')
        throwInvalidRequestError('Expected an uploaded image file.', field)
      if (field !== 'mask')
        hasImage = true
    }
    else if (multipartTextFields.has(field)) {
      if (typeof value !== 'string')
        throwInvalidRequestError('Expected a text form field.', field)
      if (field === 'prompt') {
        if (!value.length)
          throwInvalidRequestError('The prompt must not be empty.', field)
        hasPrompt = true
      }
      if (field === 'model') {
        if (++modelCount > 1)
          throwInvalidRequestError('Provide only one model field.', field)
        if (!value.length)
          throwInvalidRequestError('The model must not be empty.', field)
      }
      if (field === 'stream') {
        if (++streamCount > 1)
          throwInvalidRequestError('Provide only one stream field.', field)
        if (value !== 'true' && value !== 'false')
          throwInvalidRequestError('The stream field must be true or false.', field)
      }
    }
  })

  if (!hasImage)
    throwInvalidRequestError('At least one image file is required.', 'image')
  if (!hasPrompt)
    throwInvalidRequestError('The prompt field is required.', 'prompt')

  // Keep the original entries and File objects, including repeated future fields.
  return payload
}
