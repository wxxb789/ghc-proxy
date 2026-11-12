import { describe, expect, test } from 'bun:test'

import {
  parseImageEditFormData,
  parseImageEditRequest,
  parseImageGenerationRequest,
} from '~/ingest/validation/images'
import { HTTPError } from '~/lib/error'

function editFormData(): FormData {
  const body = new FormData()
  body.append('prompt', 'Add a blue background')
  body.append('image[]', new File(['image'], 'source.png', { type: 'image/png' }))
  return body
}

function expectInvalid(run: () => unknown) {
  try {
    run()
  }
  catch (error) {
    expect(error).toBeInstanceOf(HTTPError)
    const httpError = error as HTTPError
    expect(httpError.status).toBe(400)
    expect(httpError.body.error.type).toBe('invalid_request_error')
    return
  }
  throw new Error('Expected invalid image input to be rejected')
}

describe('image JSON validation', () => {
  const invalidImages: unknown[] = [
    [],
    null,
    {},
    [{}],
    [null],
    [{ image_url: '' }],
    [{ file_id: 1 }],
    [{ image_url: 'https://example.test/image.png', file_id: 'file-1' }],
  ]

  for (const [index, images] of invalidImages.entries()) {
    test(`rejects malformed image references ${index}`, () => {
      expectInvalid(() => parseImageEditRequest({ prompt: 'Edit', images }))
    })
  }

  test('applies the same one-reference rule to a mask', () => {
    expectInvalid(() => parseImageEditRequest({
      prompt: 'Edit',
      images: [{ file_id: 'file-1' }],
      mask: { image_url: 'https://example.test/mask.png', file_id: 'file-2' },
    }))
  })

  test('requires a generation model but leaves an edit model absent or null', () => {
    expectInvalid(() => parseImageGenerationRequest({ prompt: 'Draw a bird' }))
    const images = [{ file_id: 'file-1' }]
    expect(parseImageEditRequest({ prompt: 'Edit', images })).not.toHaveProperty('model')
    expect(parseImageEditRequest({ prompt: 'Edit', images, model: null }).model).toBeNull()
  })

  test('accepts false and null streaming without coercing JSON strings', () => {
    const body = { prompt: 'Draw', model: 'image-model' }
    expect(parseImageGenerationRequest({ ...body, stream: false }).stream).toBe(false)
    expect(parseImageGenerationRequest({ ...body, stream: null }).stream).toBeNull()
    expectInvalid(() => parseImageGenerationRequest({ ...body, stream: 'false' }))
  })
})

describe('image multipart validation', () => {
  test('rejects missing image files and text pretending to be a file', () => {
    const missing = new FormData()
    missing.append('prompt', 'Edit')
    expectInvalid(() => parseImageEditFormData(missing))
    missing.append('image', 'not-a-file')
    expectInvalid(() => parseImageEditFormData(missing))
  })

  test('rejects ambiguous repeated model and stream values', () => {
    const models = editFormData()
    models.append('model', 'first')
    models.append('model', 'second')
    expectInvalid(() => parseImageEditFormData(models))

    const streams = editFormData()
    streams.append('stream', 'false')
    streams.append('stream', 'true')
    expectInvalid(() => parseImageEditFormData(streams))
  })

  test('rejects non-boolean stream text rather than treating it as true', () => {
    const body = editFormData()
    body.append('stream', '0')
    expectInvalid(() => parseImageEditFormData(body))
  })
})
