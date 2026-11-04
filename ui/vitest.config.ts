import { mergeConfig } from 'vite'
import { defineConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(viteConfig, defineConfig({
  test: {
    environment: 'jsdom',
    // Let jsdom own browser storage instead of Node's process-wide Web Storage.
    execArgv: ['--no-experimental-webstorage'],
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/dashboard/',
      },
    },
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
}))
