import type { ClientAuth, ClientConfig } from '~/clients'
import type { CapiRequestContext } from '~/core/capi'

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
const TRAILING_SLASHES_RE = /\/+$/

/** Headers shared by both Copilot and GitHub API requests (editor identity + versioning) */
function editorHeaders(config: ClientConfig) {
  return {
    'editor-version': `vscode/${config.vsCodeVersion ?? 'unknown'}`,
    'editor-plugin-version': EDITOR_PLUGIN_VERSION,
    'user-agent': USER_AGENT,
    'x-github-api-version': API_VERSION,
    'x-vscode-user-agent-library-version': 'electron-fetch',
  }
}

export function copilotBaseUrl(config: ClientConfig) {
  if (config.copilotApiBase) {
    return config.copilotApiBase.replace(TRAILING_SLASHES_RE, '')
  }
  return config.accountType === 'individual'
    ? 'https://api.githubcopilot.com'
    : `https://api.${config.accountType}.githubcopilot.com`
}
export interface CopilotHeaderOptions {
  initiator?: 'user' | 'agent'
  requestContext?: Partial<CapiRequestContext>
  vision?: boolean
}

export function copilotHeaders(
  auth: ClientAuth,
  config: ClientConfig,
  options: CopilotHeaderOptions = {},
) {
  const requestContext = options.requestContext
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${auth.copilotToken}`,
    'content-type': standardHeaders()['content-type'],
    'copilot-integration-id': 'vscode-chat',
    ...editorHeaders(config),
    'openai-intent': 'conversation-panel',
    'x-request-id': randomUUID(),
  }

  if (options.vision)
    headers['copilot-vision-request'] = 'true'

  if (options.initiator) {
    headers['X-Initiator'] = options.initiator
  }

  if (requestContext?.interactionType) {
    headers['X-Interaction-Type'] = requestContext.interactionType
  }
  if (requestContext?.agentTaskId) {
    headers['X-Agent-Task-Id'] = requestContext.agentTaskId
  }
  if (requestContext?.parentAgentTaskId) {
    headers['X-Parent-Agent-Id'] = requestContext.parentAgentTaskId
  }
  if (requestContext?.clientSessionId) {
    headers['X-Client-Session-Id'] = requestContext.clientSessionId
  }
  if (requestContext?.interactionId) {
    headers['X-Interaction-Id'] = requestContext.interactionId
  }
  if (requestContext?.clientMachineId) {
    headers['X-Client-Machine-Id'] = requestContext.clientMachineId
  }

  return headers
}

export const GITHUB_API_BASE_URL = 'https://api.github.com'
export function githubHeaders(auth: ClientAuth, config: ClientConfig) {
  return {
    ...standardHeaders(),
    authorization: `token ${auth.githubToken}`,
    ...editorHeaders(config),
  }
}

export const GITHUB_BASE_URL = 'https://github.com'
export const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
export const GITHUB_APP_SCOPES = ['read:user'].join(' ')
