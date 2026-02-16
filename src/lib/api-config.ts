import type { ClientAuth, ClientConfig } from '~/clients'

import { randomUUID } from 'node:crypto'

export function standardHeaders() {
  return {
    'content-type': 'application/json',
    'accept': 'application/json',
  }
}

const COPILOT_VERSION = '0.26.7'
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`

const API_VERSION = '2025-04-01'

export function copilotBaseUrl(config: ClientConfig) {
  return config.accountType === 'individual'
    ? 'https://api.githubcopilot.com'
    : `https://api.${config.accountType}.githubcopilot.com`
}
export function copilotHeaders(auth: ClientAuth, config: ClientConfig, vision: boolean = false) {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${auth.copilotToken}`,
    'content-type': standardHeaders()['content-type'],
    'copilot-integration-id': 'vscode-chat',
    'editor-version': `vscode/${config.vsCodeVersion ?? 'unknown'}`,
    'editor-plugin-version': EDITOR_PLUGIN_VERSION,
    'user-agent': USER_AGENT,
    'openai-intent': 'conversation-panel',
    'x-github-api-version': API_VERSION,
    'x-request-id': randomUUID(),
    'x-vscode-user-agent-library-version': 'electron-fetch',
  }

  if (vision)
    headers['copilot-vision-request'] = 'true'

  return headers
}

export const GITHUB_API_BASE_URL = 'https://api.github.com'
export function githubHeaders(auth: ClientAuth, config: ClientConfig) {
  return {
    ...standardHeaders(),
    'authorization': `token ${auth.githubToken}`,
    'editor-version': `vscode/${config.vsCodeVersion ?? 'unknown'}`,
    'editor-plugin-version': EDITOR_PLUGIN_VERSION,
    'user-agent': USER_AGENT,
    'x-github-api-version': API_VERSION,
    'x-vscode-user-agent-library-version': 'electron-fetch',
  }
}

export const GITHUB_BASE_URL = 'https://github.com'
export const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
export const GITHUB_APP_SCOPES = ['read:user'].join(' ')
