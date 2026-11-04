import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'app',
  stylistic: true,
  react: {
    files: ['ui/src/**/*.{ts,tsx}'],
    filesTypeAware: ['ui/src/**/*.{ts,tsx}'],
    overrides: {
      'react-dom/no-dangerously-set-innerhtml': 'error',
    },
  },
  ignores: [
    'dist/**',
    'ui/dist/**',
    'src/routes/dashboard/embedded-ui.generated.ts',
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
})
