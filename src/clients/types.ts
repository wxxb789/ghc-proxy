export interface ClientAuth {
  githubToken?: string
  copilotToken?: string
  copilotApiBase?: string
}

export interface ClientConfig {
  accountType: 'individual' | 'business' | 'enterprise'
  vsCodeVersion?: string
  copilotApiBase?: string
}

export interface ClientDeps {
  fetch?: typeof fetch
}
