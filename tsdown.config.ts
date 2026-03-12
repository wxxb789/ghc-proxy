import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }

export default defineConfig({
  entry: ['src/main.ts'],

  format: ['esm'],
  target: 'es2022',
  platform: 'node',

  sourcemap: true,
  clean: true,

  define: {
    __GHC_PROXY_VERSION__: JSON.stringify(version),
  },

  env: {
    NODE_ENV: 'production',
  },
})
