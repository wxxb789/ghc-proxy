import type { Elysia } from 'elysia'

import { DASHBOARD_CSS, DASHBOARD_HTML, DASHBOARD_JS } from './assets'
import { assetResponse } from './http'

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

export function registerServingRoutes(app: Elysia) {
  return app
    .get('/dashboard', () => assetResponse(
      DASHBOARD_HTML,
      'text/html; charset=utf-8',
      { 'content-security-policy': DASHBOARD_CSP },
    ))
    .get('/dashboard/styles.css', () => assetResponse(
      DASHBOARD_CSS,
      'text/css; charset=utf-8',
    ))
    .get('/dashboard/app.js', () => assetResponse(
      DASHBOARD_JS,
      'text/javascript; charset=utf-8',
    ))
}
