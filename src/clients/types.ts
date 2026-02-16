export interface ClientAuth {
  githubToken?: string
  copilotToken?: string
}

export interface ClientConfig {
  accountType: 'individual' | 'business' | 'enterprise'
  vsCodeVersion?: string
}

export interface ClientDeps {
  fetch?: typeof fetch
}
