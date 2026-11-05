import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'app',
  stylistic: true,
  componentExts: ['svelte'],
  svelte: {
    overrides: {
      // The Dashboard CSP (style-src 'self') blocks inline style attributes.
      'svelte/no-inline-styles': 'error',
      'svelte/no-at-html-tags': 'error',
      'svelte/require-each-key': 'error',
    },
  },
  ignores: [
    'dist/**',
    'node_modules/**',
    'plans/**',
    // .NET project: no JavaScript to lint, and bin/obj hold generated JSON.
    'msc-auth/**',
    // Locally installed agent skills; not part of the package or CI.
    '.agents/**',
    'docs/superpowers/**',
    // upgrade-deps workflow output — Workflow tool DSL injects agent()/phase()/
    // pipeline() and a top-level return, so eslint cannot parse it. Generated
    // plan in docs/upgrade-plan.md is also produced verbatim by the workflow
    // and re-flowing its headings would invalidate the next run's diff.
    '.claude/workflows/**',
    'docs/upgrade-plan.md',
  ],
}, {
  // Motion lives in the external stylesheet; Svelte transitions are banned (spec §3.8).
  files: ['ui/**'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: ['svelte/transition', 'svelte/animate', 'svelte/motion'].map(name => ({ name, message: 'Use CSS classes and @keyframes in app.css instead.' })),
    }],
  },
})
