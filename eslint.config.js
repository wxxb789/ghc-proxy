import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'app',
  stylistic: true,
  ignores: [
    'dist/**',
    'node_modules/**',
    'plans/**',
  ],
})
