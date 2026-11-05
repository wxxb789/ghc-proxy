import { fileURLToPath } from 'node:url'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/dashboard/',
  plugins: [
    // Component CSS stays external (emitCss default): the CSP blocks injected <style>.
    // fragments 'tree' builds DOM nodes without <template>.innerHTML; it measured ~50 B gzip
    // smaller than the default 'html' and needs no Trusted Types allowance.
    // cssHash: a 6-character scoped class instead of `svelte-xxxxxxx` (it repeats in every template).
    // The last 5 base36 digits of the 32-bit hash are uniform; ~60 components cannot realistically collide.
    svelte({
      configFile: false,
      compilerOptions: { runes: true, discloseVersion: false, fragments: 'tree', cssHash: ({ hash, css }) => `s${hash(css).slice(-5)}` },
    }),
  ],
  resolve: {
    alias: {
      '@contract': fileURLToPath(new URL('../src/routes/dashboard/contract.ts', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    fs: { allow: [repoRoot] },
    // Object form without changeOrigin: Host and Origin pass through unchanged,
    // so the Dashboard's same-origin guard needs no relaxation.
    proxy: { '/dashboard/api': { target: 'http://127.0.0.1:4141' } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: false,
        entryFileNames: 'assets/app.js',
        assetFileNames: 'assets/app[extname]',
      },
    },
  },
})
