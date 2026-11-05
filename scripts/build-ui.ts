// Builds the Dashboard UI (ui/) with Vite and embeds the output as a generated
// TypeScript module that tsdown bundles into dist/. Runs before tsdown because
// tsdown cleans dist/. Fails on CSP-incompatible output or a blown size budget.
import type { EmbeddedUiAsset, EmbeddedUiPath } from '../src/routes/dashboard/embedded-ui'
import { Buffer } from 'node:buffer'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build } from 'vite'
import { DASHBOARD_UI_INDEX_PATH, EMBEDDED_UI_PATHS } from '../src/routes/dashboard/embedded-ui'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const outputDirectory = join(repoRoot, 'ui/dist')
const generatedModule = join(repoRoot, 'src/routes/dashboard/embedded-ui.generated.ts')

const CONTENT_TYPES: Record<EmbeddedUiPath, string> = {
  '/dashboard/index.html': 'text/html; charset=utf-8',
  '/dashboard/assets/app.js': 'text/javascript; charset=utf-8',
  '/dashboard/assets/app.css': 'text/css; charset=utf-8',
  '/dashboard/theme-init.js': 'text/javascript; charset=utf-8',
}

// gzip -9 budgets. The Svelte runtime is ~17 kB; the rest is the app itself.
// JS: measured 56.9 kB (app.js + theme-init.js), rounded up to 57 kB, plus ~2 % (soft) and ~6 % (hard).
const JS_SOFT_BUDGET = 58_200
const JS_HARD_BUDGET = 60_500
const CSS_SOFT_BUDGET = 12_000
const CSS_HARD_BUDGET = 20_000

const HTML_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
const HTML_SCRIPT_SOURCE_RE = /\bsrc\s*=\s*["'][^"']+["']/i
const HTML_STYLE_ELEMENT_RE = /<style\b/i
const HTML_STYLE_ATTRIBUTE_RE = /<[^>]*\sstyle\s*=/i
// Compiled Svelte templates are HTML strings (fragments 'html') or element
// arrays (fragments 'tree'); the minifier may quote any literal with ', " or `.
// A template style attribute or <style> element is blocked by style-src 'self'.
const TEMPLATE_STYLE_ATTRIBUTE_RE = /<[a-z][\w-]*\s[^<>]*\bstyle=/i
const TEMPLATE_STYLE_ELEMENT_RE = /<style[\s>]/i
const TREE_STYLE_ATTRIBUTE_RE = /[{,]\s*["'`]?style["'`]?\s*:/
// A 'style' string anywhere else is a runtime <style> element (tree entries,
// createElement, Svelte's injected CSS) or a style attribute (setAttribute).
// Svelte's own `Symbol('style')` key is the one allowed use.
const STYLE_LITERAL_RE = /(?<!Symbol\(\s*)["'`]style["'`]/
const JAVASCRIPT_POLICY: Array<[RegExp, string]> = [
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\s*\(/, 'new Function()'],
  [TEMPLATE_STYLE_ATTRIBUTE_RE, 'an inline style attribute in a template'],
  [TEMPLATE_STYLE_ELEMENT_RE, 'a <style> element in a template'],
  [TREE_STYLE_ATTRIBUTE_RE, 'an inline style attribute in a template tree'],
  [STYLE_LITERAL_RE, 'a runtime <style> element or style attribute'],
]

// Minified shapes the scan must keep catching, and clean ones it must pass.
const POLICY_VIOLATIONS = [
  '$.from_html(`<div class="a" style="color:red">`)',
  '$.from_html(`<div><style>a{color:red}</style></div>`)',
  '[[`div`,{class:`a`,style:`color:red`}]]',
  '[[`div`,null,[`style`,null,`a{color:red}`]]]',
  'document.createElement(`style`)',
  'document.createElement("style")',
  'e.setAttribute(`style`,t)',
]
const POLICY_CLEAN = ['pe=Symbol(`style`)', '[[`div`,{class:`styled`,"aria-label":`Style`}]]', 'e.style.setProperty(`--pct`,t)']

function assertPolicySelfTest(): void {
  const violates = (sample: string) => JAVASCRIPT_POLICY.some(([pattern]) => pattern.test(sample))
  const missed = POLICY_VIOLATIONS.filter(sample => !violates(sample))
  const flagged = POLICY_CLEAN.filter(violates)
  if (missed.length || flagged.length)
    throw new Error(`CSP scan self-test failed. Missed: ${missed.join(' | ') || 'none'}. Flagged: ${flagged.join(' | ') || 'none'}.`)
}

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory())
      files.push(...await listFiles(join(directory, entry.name), relativePath))
    else if (entry.isFile())
      files.push(relativePath)
    else
      throw new Error(`Unsupported UI output: ${relativePath}`)
  }
  return files
}

function assertHtmlPolicy(html: string): void {
  for (const match of html.matchAll(HTML_SCRIPT_RE)) {
    if (!HTML_SCRIPT_SOURCE_RE.test(match[1] ?? '') || match[2]?.trim())
      throw new Error('UI output contains an inline script')
  }
  if (HTML_STYLE_ELEMENT_RE.test(html))
    throw new Error('UI output contains an inline style element')
  if (HTML_STYLE_ATTRIBUTE_RE.test(html))
    throw new Error('UI output contains an inline style attribute')
}

function assertJavaScriptPolicy(path: string, content: string): void {
  for (const [pattern, description] of JAVASCRIPT_POLICY) {
    if (pattern.test(content))
      throw new Error(`UI output contains ${description}: ${path}`)
  }
}

function formatSize(bytes: number): string {
  return `${(bytes / 1000).toFixed(2)} kB`
}

assertPolicySelfTest()
await build({ configFile: join(repoRoot, 'ui/vite.config.ts'), logLevel: 'warn' })

const expectedFiles = EMBEDDED_UI_PATHS.map(path => path.slice('/dashboard/'.length)).sort()
const actualFiles = (await listFiles(outputDirectory)).sort()
const missing = expectedFiles.filter(path => !actualFiles.includes(path))
const extra = actualFiles.filter(path => !expectedFiles.includes(path))
if (missing.length || extra.length)
  throw new Error(`Unexpected UI output set. Missing: ${missing.join(', ') || 'none'}. Extra: ${extra.join(', ') || 'none'}.`)

const assets: Partial<Record<EmbeddedUiPath, EmbeddedUiAsset>> = {}
let javaScriptBytes = 0
let cssBytes = 0
for (const path of EMBEDDED_UI_PATHS) {
  const content = await readFile(join(outputDirectory, path.slice('/dashboard/'.length)), 'utf8')
  if (path === DASHBOARD_UI_INDEX_PATH)
    assertHtmlPolicy(content)
  if (path.endsWith('.js'))
    assertJavaScriptPolicy(path, content)
  assets[path] = { content, contentType: CONTENT_TYPES[path] }

  const gzipBytes = gzipSync(content, { level: 9 }).byteLength
  if (path.endsWith('.js'))
    javaScriptBytes += gzipBytes
  if (path.endsWith('.css'))
    cssBytes += gzipBytes
  console.log(`${path.padEnd(28)} ${formatSize(Buffer.byteLength(content)).padStart(10)} raw ${formatSize(gzipBytes).padStart(10)} gzip`)
}

console.log(`JavaScript ${formatSize(javaScriptBytes)} gzip (soft ${formatSize(JS_SOFT_BUDGET)}, hard ${formatSize(JS_HARD_BUDGET)})`)
console.log(`CSS ${formatSize(cssBytes)} gzip (soft ${formatSize(CSS_SOFT_BUDGET)}, hard ${formatSize(CSS_HARD_BUDGET)})`)
if (javaScriptBytes > JS_HARD_BUDGET)
  throw new Error('Dashboard JavaScript exceeds its hard gzip budget')
if (cssBytes > CSS_HARD_BUDGET)
  throw new Error('Dashboard CSS exceeds its hard gzip budget')
if (javaScriptBytes > JS_SOFT_BUDGET)
  console.warn('Dashboard JavaScript exceeds its soft gzip budget')
if (cssBytes > CSS_SOFT_BUDGET)
  console.warn('Dashboard CSS exceeds its soft gzip budget')

await writeFile(
  generatedModule,
  `// Generated by scripts/build-ui.ts. Do not edit.\nimport type { EmbeddedUi } from '~/routes/dashboard/embedded-ui'\n\nexport const embeddedUi = ${JSON.stringify(assets)} satisfies EmbeddedUi\n`,
  'utf8',
)
console.log('Embedded the Dashboard UI in src/routes/dashboard/embedded-ui.generated.ts')
