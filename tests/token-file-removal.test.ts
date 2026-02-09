import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "ghc-proxy-test-token-"),
)

await mock.module("node:os", () => ({
  ...os,
  homedir: () => tempDir,
}))

await mock.module("consola", () => ({
  default: {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
}))

const mockPollAccessToken = mock(() => Promise.resolve("new-test-token"))
await mock.module("../src/clients", () => ({
  getVSCodeVersion: mock(() => Promise.resolve("1.91.0")),
  CopilotClient: class {
    getModels = () => Promise.resolve({ data: [] })
  },
  GitHubClient: class {
    getGitHubUser = () => Promise.resolve({ login: "test-user" })
    getDeviceCode = () =>
      Promise.resolve({
        user_code: "1234",
        verification_uri: "http://test",
        device_code: "dc",
        expires_in: 60,
        interval: 1,
      })
    pollAccessToken = mockPollAccessToken
    getCopilotToken = () =>
      Promise.resolve({ token: "copilot-token", refresh_in: 1800 })
  },
}))

const { PATHS, ensurePaths } = await import("../src/lib/paths")
const { setupGitHubToken } = await import("../src/lib/token")
const { state } = await import("../src/lib/state")
const { readConfig } = await import("../src/lib/config")

describe("Token file removal (RED phase)", () => {
  beforeEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
    await fs.mkdir(tempDir, { recursive: true })

    state.auth = {}
    state.cache = {}
    state.config = {
      accountType: "individual",
      manualApprove: false,
      rateLimitWait: false,
      showToken: false,
    }

    mockPollAccessToken.mockClear()
  })

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test("1. ensurePaths() should NOT create the old token file", async () => {
    await ensurePaths()

    const appDirExists = await fs
      .access(PATHS.APP_DIR)
      .then(() => true)
      .catch(() => false)
    expect(appDirExists).toBe(true)
  })

  test("2. setupGitHubToken() should NOT read from the old token file", async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({}))
    await readConfig()

    await setupGitHubToken()

    expect(state.auth.githubToken).toBe("new-test-token")
  })

  test("3. setupGitHubToken() should write to config.json only", async () => {
    await fs.writeFile(PATHS.CONFIG_PATH, JSON.stringify({}))
    await readConfig()

    await setupGitHubToken({ force: true })

    const configContent = await fs.readFile(PATHS.CONFIG_PATH)
    const config = JSON.parse(configContent) as { githubToken: string }

    expect(config.githubToken).toBe("new-test-token")
  })
})
