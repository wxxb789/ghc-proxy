import { svelteTesting } from '@testing-library/svelte/vite'
import { mergeConfig } from 'vite'
import { defineConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

export default mergeConfig(viteConfig, defineConfig({
  plugins: [svelteTesting()],
  test: {
    environment: 'jsdom',
    // Node 25+ ships its own localStorage, which shadows jsdom's.
    execArgv: ['--no-experimental-webstorage'],
    environmentOptions: { jsdom: { url: 'http://localhost:4141/dashboard' } },
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
  },
}))
