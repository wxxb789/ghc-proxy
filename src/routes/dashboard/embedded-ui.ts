import { fileURLToPath } from 'node:url'

export const DASHBOARD_UI_INDEX_PATH = '/dashboard/index.html'
export const DASHBOARD_UI_ASSET_PATHS = [
  '/dashboard/assets/app.js',
  '/dashboard/assets/app.css',
  '/dashboard/theme-init.js',
] as const
export const EMBEDDED_UI_PATHS = [DASHBOARD_UI_INDEX_PATH, ...DASHBOARD_UI_ASSET_PATHS] as const

export type EmbeddedUiPath = typeof EMBEDDED_UI_PATHS[number]

export interface EmbeddedUiAsset {
  readonly content: string
  readonly contentType: string
}

export type EmbeddedUi = Readonly<Record<EmbeddedUiPath, EmbeddedUiAsset>>

function isMissingGeneratedModule(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error))
    return false

  if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_MODULE_NOT_FOUND')
    return false
  if (error.message.startsWith('Cannot find module \'./embedded-ui.generated\' '))
    return true
  if (!('url' in error))
    return false

  const moduleUrl = new URL('./embedded-ui.generated', import.meta.url)
  const sourceUrl = new URL('./embedded-ui.generated.ts', import.meta.url)
  return error.url === moduleUrl.href
    || error.url === sourceUrl.href
    || error.url === fileURLToPath(moduleUrl)
    || error.url === fileURLToPath(sourceUrl)
}

export async function loadEmbeddedUi(): Promise<EmbeddedUi | undefined> {
  try {
    // Unbuilt source checkouts have no generated module; a static import would bypass the 503 path.
    const { embeddedUi } = await import('./embedded-ui.generated')
    return embeddedUi
  }
  catch (error) {
    if (isMissingGeneratedModule(error))
      return undefined
    throw error
  }
}
