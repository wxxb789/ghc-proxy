import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'app',
  stylistic: true,
  ignores: [
    'dist/**',
    'node_modules/**',
    'plans/**',
    'docs/superpowers/**',
    // upgrade-deps workflow output — Workflow tool DSL injects agent()/phase()/
    // pipeline() and a top-level return, so eslint cannot parse it. Generated
    // plan in docs/upgrade-plan.md is also produced verbatim by the workflow
    // and re-flowing its headings would invalidate the next run's diff.
    '.claude/workflows/**',
    'docs/upgrade-plan.md',
  ],
})
