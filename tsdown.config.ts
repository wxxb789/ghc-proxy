import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }

export default defineConfig({
  entry: ['src/main.ts'],

  format: ['esm'],
  target: 'es2022',
  platform: 'node',

  // tsdown 0.21.0 moved dependency options under `deps`. The legacy
  // `noExternal`/`inlineOnly` keys still build but only log a deprecation
  // warning, and 0.21.0 also flipped `failOnWarn` default to `false`, so
  // those warnings would silently disappear in CI. Use the new namespace.
  //
  // `alwaysBundle: [/.*/]` bundles every dependency into dist/main.mjs —
  // intentional for the single-file CLI distribution. tsdown 0.22.x then
  // prints a "consider adding deps.onlyBundle" Hint listing 20+ inlined
  // deps on every build; the explicit `onlyBundle: false` silences it
  // (we always bundle by design, so the safety prompt does not apply).
  deps: {
    alwaysBundle: [/.*/],
    onlyBundle: false,
  },
  sourcemap: true,
  clean: true,

  // Note: do NOT enable `exports` in this config. tsdown 0.22.0 will
  // auto-write `exports` and `inlinedDependencies` into package.json on
  // every build when any `exports` config is set — even `exports.bin:
  // false`. We hand-maintain `bin` in package.json (./dist/main.mjs); a
  // single entry with one shebang means tsdown's auto-bin write is
  // already inert without configuring exports.

  define: {
    __GHC_PROXY_VERSION__: JSON.stringify(version),
  },

  env: {
    NODE_ENV: 'production',
  },
})
