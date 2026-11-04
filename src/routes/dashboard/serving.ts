import type { Elysia } from 'elysia'
import type { EmbeddedUi } from './embedded-ui'

import { DASHBOARD_PAGES } from '~/types/dashboard'
import { DASHBOARD_UI_ASSET_PATHS, DASHBOARD_UI_INDEX_PATH, loadEmbeddedUi } from './embedded-ui'
import { apiError, assetResponse, BASE_HEADERS } from './http'

const DASHBOARD_CSP = [
  'default-src \'none\'',
  'script-src \'self\'',
  'style-src \'self\'',
  'connect-src \'self\'',
  'img-src \'self\' data:',
  'base-uri \'none\'',
  'frame-ancestors \'none\'',
  'form-action \'none\'',
  'object-src \'none\'',
].join('; ')

export function registerServingRoutes(app: Elysia, ui?: EmbeddedUi | null) {
  let pendingUi: Promise<EmbeddedUi | undefined> | undefined
  const shell = async () => {
    const manifest = await (ui === undefined ? pendingUi ??= loadEmbeddedUi() : ui)
    if (!manifest) {
      return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dashboard UI not built</title></head><body><h1>Dashboard UI not built</h1><p>Build the Dashboard before opening it from a source checkout.</p></body></html>', {
        status: 503,
        headers: {
          ...BASE_HEADERS,
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': DASHBOARD_CSP,
        },
      })
    }
    const index = manifest[DASHBOARD_UI_INDEX_PATH]
    return assetResponse(index.content, index.contentType, { 'content-security-policy': DASHBOARD_CSP })
  }

  app.get('/dashboard', shell)
  for (const page of DASHBOARD_PAGES)
    app.get(`/dashboard/${page}`, shell)
  for (const path of DASHBOARD_UI_ASSET_PATHS) {
    app.get(path, async () => {
      const manifest = await (ui === undefined ? pendingUi ??= loadEmbeddedUi() : ui)
      if (!manifest)
        return apiError('Dashboard UI is not built.', 503)
      const asset = manifest[path]
      return assetResponse(asset.content, asset.contentType)
    })
  }
  return app
}
