// Extract reportMarkdown from a Workflow output dump and write to docs/upgrade-plan.md.
// One-shot helper for the upgrade-deps workflow. Path is positional arg 0.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const src = process.argv[2]
if (!src) {
  console.error('usage: bun run scripts/dev/extract-workflow-report.ts <workflow-output-path>')
  process.exit(1)
}

const raw = readFileSync(src, 'utf8')
const key = '"reportMarkdown"'
const idx = raw.indexOf(key)
if (idx < 0) {
  console.error('reportMarkdown key not found in', src)
  process.exit(2)
}

// Walk back to the enclosing object's opening brace.
let i = idx
let depth = 0
while (i >= 0) {
  const ch = raw[i]
  if (ch === '}') {
    depth++
  }
  else if (ch === '{') {
    if (depth === 0)
      break
    depth--
  }
  i--
}
if (i < 0) {
  console.error('could not find opening brace before reportMarkdown')
  process.exit(3)
}

// Walk forward to the matching closing brace, respecting string + escape state.
let j = i
let d = 0
let inStr = false
let esc = false
for (; j < raw.length; j++) {
  const c = raw[j]
  if (inStr) {
    if (esc) {
      esc = false
    }
    else if (c === '\\') {
      esc = true
    }
    else if (c === '"') {
      inStr = false
    }
    continue
  }
  if (c === '"') {
    inStr = true
  }
  else if (c === '{') {
    d++
  }
  else if (c === '}') {
    d--
    if (d === 0) {
      j++
      break
    }
  }
}

const slice = raw.slice(i, j)
const obj = JSON.parse(slice)
if (typeof obj.reportMarkdown !== 'string') {
  console.error('reportMarkdown is not a string')
  process.exit(4)
}

mkdirSync('docs', { recursive: true })
writeFileSync('docs/upgrade-plan.md', obj.reportMarkdown, 'utf8')

console.log('wrote docs/upgrade-plan.md', obj.reportMarkdown.length, 'chars')
console.log('safe:', obj.safeBatch?.length, 'review:', obj.reviewBatch?.length, 'blocked:', obj.blockedBatch?.length)
console.log('--- bumpCommands.safe ---')
console.log(obj.bumpCommands.safe)
console.log('--- bumpCommands.review ---')
console.log(obj.bumpCommands.review)
console.log('--- bumpCommands.blocked ---')
console.log(obj.bumpCommands.blocked)
