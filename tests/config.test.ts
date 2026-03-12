import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  getCachedConfig,
  readConfig,
  writeConfigField,
} from '../src/lib/config'

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ghc-proxy-test-'))
const tempConfigPath = path.join(tempDir, 'config.json')

mock.module('../src/lib/paths', () => ({
  PATHS: {
    APP_DIR: tempDir,
    CONFIG_PATH: tempConfigPath,
  },
}))

describe('config module', () => {
  beforeEach(async () => {
    await fs.unlink(tempConfigPath).catch(() => {

    })
    await readConfig()
  })

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('readConfig() — file doesn\'t exist → returns {}', async () => {
    const config = await readConfig()
    expect(config).toEqual({})
  })

  test('readConfig() — file is empty string → returns {}', async () => {
    await fs.writeFile(tempConfigPath, '')
    const config = await readConfig()
    expect(config).toEqual({})
  })

  test('readConfig() — malformed JSON → returns {}, warns', async () => {
    await fs.writeFile(tempConfigPath, '{ invalid json }')
    const config = await readConfig()
    expect(config).toEqual({})
  })

  test('readConfig() — valid JSON with full config → returns parsed object', async () => {
    const fullConfig = {
      githubToken: 'test-token',
      modelFallback: {
        claudeOpus: 'gpt-4-opus',
      },
    }
    await fs.writeFile(tempConfigPath, JSON.stringify(fullConfig))
    const config = await readConfig()
    expect(config).toEqual(fullConfig)
  })

  test('readConfig() — partial config → returns partial object', async () => {
    const partialConfig = {
      modelFallback: {
        claudeOpus: 'gpt-4-opus',
      },
    }
    await fs.writeFile(tempConfigPath, JSON.stringify(partialConfig))
    const config = await readConfig()
    expect(config).toEqual(partialConfig)
  })

  test('readConfig() — config is array → returns {}, warns', async () => {
    await fs.writeFile(tempConfigPath, JSON.stringify(['not', 'an', 'object']))
    const config = await readConfig()
    expect(config).toEqual({})
  })

  test('writeConfigField() — file doesn\'t exist → creates file, keeps platform-appropriate permissions', async () => {
    await writeConfigField('githubToken', 'new-token')

    const content = await fs.readFile(tempConfigPath)
    const parsed = JSON.parse(content.toString()) as unknown
    expect(parsed).toEqual({ githubToken: 'new-token' })

    if (process.platform !== 'win32') {
      const stats = await fs.stat(tempConfigPath)
      expect(stats.mode & 0o777).toBe(0o600)
    }
  })

  test('writeConfigField() — merges with existing fields', async () => {
    await fs.writeFile(tempConfigPath, JSON.stringify({ existing: 'value' }))
    await writeConfigField('githubToken', 'new-token')

    const content = await fs.readFile(tempConfigPath)
    const parsed = JSON.parse(content.toString()) as unknown
    expect(parsed).toEqual({ existing: 'value', githubToken: 'new-token' })
  })

  test('getCachedConfig() — returns last loaded/written config', async () => {
    const testConfig = { githubToken: 'cached-token' }
    await fs.writeFile(tempConfigPath, JSON.stringify(testConfig))

    await readConfig()
    expect(getCachedConfig()).toEqual(testConfig)

    await writeConfigField('githubToken', 'updated-token')
    expect(getCachedConfig()).toEqual({ githubToken: 'updated-token' })
  })
})
