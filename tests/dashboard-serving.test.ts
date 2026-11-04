import type { EmbeddedUi } from '~/routes/dashboard/embedded-ui'

import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { createDashboardRoutes } from '~/routes/dashboard/route'
import { toErrorResponse } from '~/server'
import { DASHBOARD_PAGES } from '~/types/dashboard'

const ui: EmbeddedUi = {
  '/dashboard/index.html': {
    content: '<!doctype html><html lang="en"><head><script src="/dashboard/theme-init.js"></script><link rel="stylesheet" href="/dashboard/assets/app.css"></head><body><main></main><script type="module" src="/dashboard/assets/app.js"></script></body></html>',
    contentType: 'text/html; charset=utf-8',
  },
  '/dashboard/assets/app.js': {
    content: 'document.querySelector("main").textContent = "Dashboard";',
    contentType: 'text/javascript; charset=utf-8',
  },
  '/dashboard/assets/app.css': {
    content: ':root { color-scheme: light dark; }',
    contentType: 'text/css; charset=utf-8',
  },
  '/dashboard/theme-init.js': {
    content: 'document.documentElement.dataset.theme = "dark";',
    contentType: 'text/javascript; charset=utf-8',
  },
}

function createApp(manifest: EmbeddedUi | null = ui) {
  return new Elysia()
    .onError(({ code, error }) => toErrorResponse({ code, error }))
    .use(createDashboardRoutes({ ui: manifest }))
}

describe('embedded Dashboard serving', () => {
  test('serves the shell for every exact page and its trailing-slash form', async () => {
    const app = createApp()
    for (const path of ['/dashboard', ...DASHBOARD_PAGES.map(page => `/dashboard/${page}`)]) {
      for (const suffix of ['', '/']) {
        const response = await app.handle(new Request(`http://localhost${path}${suffix}`))
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('content-security-policy')).toBe('default-src \'none\'; script-src \'self\'; style-src \'self\'; connect-src \'self\'; img-src \'self\' data:; base-uri \'none\'; frame-ancestors \'none\'; form-action \'none\'; object-src \'none\'')
      }
    }
  })

  test('fetches every external shell reference with its content type and without a shell CSP', async () => {
    const app = createApp()
    const shell = await app.handle(new Request('http://localhost/dashboard'))
    const html = await shell.text()
    const references = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g), match => match[1]!)
    expect(references).toHaveLength(3)

    for (const reference of references) {
      const response = await app.handle(new Request(new URL(reference, 'http://localhost/dashboard').href))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(reference.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('content-security-policy')).toBeNull()
    }
  })

  test('does not turn unknown API, asset, or page paths into the shell', async () => {
    for (const app of [createApp(), createApp(null)]) {
      for (const path of ['/dashboard/api/nope', '/dashboard/assets/nope.js', '/dashboard/nope', '/dashboard/traffic/nested']) {
        const response = await app.handle(new Request(`http://localhost${path}`))
        expect(response.status).toBe(404)
        expect(response.headers.get('content-type')).toContain('application/json')
        expect(await response.json()).toMatchObject({ error: { type: 'not_found_error' } })
      }
    }
  })

  test('serves a script-free unavailable page when the manifest is deliberately absent', async () => {
    const app = createApp(null)
    for (const path of ['/dashboard', '/dashboard/requests/']) {
      const response = await app.handle(new Request(`http://localhost${path}`))
      expect(response.status).toBe(503)
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('content-security-policy')).toContain('script-src \'self\'')
      const html = await response.text()
      expect(html).not.toMatch(/<script\b/i)
    }
    const asset = await app.handle(new Request('http://localhost/dashboard/assets/app.js'))
    expect(asset.status).toBe(503)
    expect(asset.headers.get('content-type')).toContain('application/json')
    expect(asset.headers.get('content-security-policy')).toBeNull()
  })

  test('applies the same Origin, hostname, and live-peer boundary to pages, assets, and APIs', async () => {
    const app = createApp()
    for (const path of ['/dashboard/traffic', '/dashboard/assets/app.js', '/dashboard/api/models']) {
      const foreign = await app.handle(new Request(`http://localhost${path}`, {
        headers: { origin: 'http://localhost:5173' },
      }))
      const foreignHost = await app.handle(new Request(`http://attacker.example${path}`, {
        headers: { origin: 'http://attacker.example' },
      }))
      const remotePeer = await app.handle(Object.assign(new Request(`http://localhost${path}`), {
        ip: '203.0.113.7',
        runtime: { name: 'node', node: {} },
      }))
      expect(foreign.status).toBe(403)
      expect(foreignHost.status).toBe(403)
      expect(remotePeer.status).toBe(403)
      expect(await foreign.json()).toMatchObject({ error: { type: 'invalid_request_error' } })
    }
  })
})
