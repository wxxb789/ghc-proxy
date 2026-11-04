import type { DashboardTarget } from '@contract'
import { useState } from 'react'
import { useDashboard } from '../../app/context'
import { copyText } from '../../lib/format'

export function ClientSnippet({ target }: { target: DashboardTarget }) {
  const { announce } = useDashboard()
  const [message, setMessage] = useState('')
  const openAI = `OPENAI_BASE_URL=${target.client.openAIBaseUrl}\nOPENAI_API_KEY=dummy-token`
  const anthropic = `ANTHROPIC_BASE_URL=${target.client.anthropicBaseUrl}\nANTHROPIC_AUTH_TOKEN=dummy-token${target.client.model ? `\nANTHROPIC_MODEL=${target.client.model}` : ''}`
  async function copySnippet(text: string) {
    try {
      await copyText(text)
      setMessage('Client settings copied.')
      announce('Client settings copied.')
    }
    catch (error) {
      const result = error instanceof Error ? error.message : 'Copy failed.'
      setMessage(result)
      announce(result)
    }
  }
  return (
    <section aria-label={`Client setup for ${target.name}`} className="target-client">
      <details>
        <summary>{`Client setup for ${target.name}`}</summary>
        <div className="grid-cards">
          <div className="stack">
            <h3>OpenAI</h3>
            <pre>{openAI}</pre>
            <button type="button" onClick={() => { void copySnippet(openAI) }}>
              {`Copy OpenAI settings for ${target.name}`}
            </button>
          </div>
          <div className="stack">
            <h3>Anthropic</h3>
            <pre>{anthropic}</pre>
            <button type="button" onClick={() => { void copySnippet(anthropic) }}>
              {`Copy Anthropic settings for ${target.name}`}
            </button>
          </div>
        </div>
        <p className="muted">The API key values above are client placeholders, not account credentials.</p>
        {message && <p>{message}</p>}
      </details>
    </section>
  )
}
