import { describe, expect, test } from 'bun:test'
import { normalizeOutputConfigEffort } from '~/transform'

import { buildModel } from './helpers'

function modelWithEfforts(efforts: Array<string>) {
  const model = buildModel('claude-test', { supported_endpoints: ['/v1/messages'] })
  model.capabilities.supports.reasoning_effort = efforts
  return model
}

describe('normalizeOutputConfigEffort', () => {
  test('passes through a supported effort unchanged', () => {
    const model = modelWithEfforts(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(normalizeOutputConfigEffort('xhigh', model)).toBe('xhigh')
    expect(normalizeOutputConfigEffort('max', model)).toBe('max')
  })

  test('clamps an unsupported effort to the highest advertised level', () => {
    // Canonical ordering low < medium < high < xhigh < max: when both max and
    // xhigh are advertised, the highest is max — not xhigh.
    const model = modelWithEfforts(['xhigh', 'max'])
    expect(normalizeOutputConfigEffort('low', model)).toBe('max')
  })

  test('treats max as higher than xhigh when clamping', () => {
    const model = modelWithEfforts(['high', 'xhigh', 'max'])
    expect(normalizeOutputConfigEffort('medium', model)).toBe('max')
  })

  test('clamps to xhigh when max is not advertised', () => {
    // Mirrors live opus-4.6 / sonnet-4.6, which advertise no xhigh — here the
    // inverse: a model that tops out at xhigh must clamp down to xhigh.
    const model = modelWithEfforts(['low', 'medium', 'high', 'xhigh'])
    expect(normalizeOutputConfigEffort('max', model)).toBe('xhigh')
  })

  test('returns undefined when the model advertises no reasoning_effort', () => {
    const model = buildModel('claude-test', { supported_endpoints: ['/v1/messages'] })
    expect(normalizeOutputConfigEffort('high', model)).toBeUndefined()
  })

  test('returns undefined when model metadata is missing', () => {
    expect(normalizeOutputConfigEffort('high', undefined)).toBeUndefined()
  })
})
