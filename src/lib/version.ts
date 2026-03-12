import { readFileSync } from 'node:fs'

declare const __GHC_PROXY_VERSION__: string | undefined

function readVersionFromSource(): string {
  try {
    const url = new URL('../../package.json', import.meta.url)
    const packageJson = JSON.parse(readFileSync(url, 'utf8')) as { version: string }
    return packageJson.version
  }
  catch {
    return 'unknown'
  }
}

// Build-time injected by tsdown `define`; falls back to reading package.json in dev
export const VERSION: string = typeof __GHC_PROXY_VERSION__ !== 'undefined'
  ? __GHC_PROXY_VERSION__
  : readVersionFromSource()
