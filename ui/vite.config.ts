import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/dashboard/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@contract': fileURLToPath(new URL('../src/types/dashboard.ts', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    fs: { allow: [repoRoot] },
    proxy: {
      '/dashboard/api': {
        target: 'http://127.0.0.1:4141',
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: false,
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: asset => asset.names.some(name => name.endsWith('.css'))
          ? 'assets/app.css'
          : 'assets/[name][extname]',
        comments: { legal: true },
      },
    },
  },
})
