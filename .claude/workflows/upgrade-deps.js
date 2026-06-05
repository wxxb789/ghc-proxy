export const meta = {
  name: 'upgrade-deps',
  description: 'Audit outdated npm deps, research breaking changes, and produce a tiered upgrade plan',
  whenToUse: 'When the user wants to bump dependencies safely — especially major/pre-1.0 bumps like tsdown (Rolldown-backed), knip 6, @antfu/eslint-config 9, undici 8, typescript 6.',
  phases: [
    { title: 'Discover', detail: 'collect outdated table + repo usage surface (passed in via args)' },
    { title: 'Classify', detail: 'split into patch / minor / major (or pre-1.0 minor) tiers' },
    { title: 'Research', detail: 'per-dep changelog + breaking-change extraction (pipeline)' },
    { title: 'Verify', detail: 'adversarial refute-the-no-impact-claim for high-risk bumps' },
    { title: 'Synthesize', detail: 'tiered batch plan + command list, write upgrade-plan.md' },
  ],
}

// ---------- inputs ----------
// args shape (all optional — sensible defaults):
// {
//   outdated: [{ name, current, update, latest, kind: 'dep'|'devDep' }, ...]
//   distTags: { [pkg]: { latest, beta?, next?, ... } }
//   usageHints: { tsdownConfigPath, eslintConfigPath, hasKnipConfig, lintScriptUsesESLintFlat, ... }
//   bundlerContext: { [pkg]: 'Free-text engine-layer / underlying-tool context the research agent must reconcile against.
//                              Example for tsdown: rolldown 1.0/1.1 default changes (lazyBarrel, inlineConst.mode, CJS interop output).' }
//   only: ['pkgA', 'pkgB']  // optional filter — limit research to these names; patch tier still folded into safeBatch
//   reportPath: 'docs/upgrade-plan.md' (default)
// }
const input = args ?? {}
const reportPath = input.reportPath ?? 'docs/upgrade-plan.md'
const outdated = Array.isArray(input.outdated) ? input.outdated : []
const distTags = input.distTags ?? {}
const usage = input.usageHints ?? {}
const bundlerContext = input.bundlerContext ?? {}
const onlyFilter = Array.isArray(input.only) && input.only.length > 0 ? new Set(input.only) : null

if (outdated.length === 0) {
  log('No outdated entries supplied via args.outdated — workflow expects the caller to have run `bun outdated` and passed the parsed rows. Aborting cleanly.')
  return { error: 'missing args.outdated', hint: 'Pass {outdated: [{name,current,update,latest,kind}], distTags, usageHints} to Workflow.' }
}

// ---------- helpers (no Date.now / Math.random — keep workflow resumable) ----------
function semverParts(v) {
  if (!v) return null
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3] }
}
function classify(row) {
  const c = semverParts(row.current)
  const l = semverParts(row.latest)
  if (!c || !l) return 'unknown'
  if (l.major !== c.major) return l.major === 0 || c.major === 0 ? 'pre1-major' : 'major'
  if (c.major === 0 && l.minor !== c.minor) return 'pre1-minor' // pre-1.0 minor = de-facto breaking
  if (l.minor !== c.minor) return 'minor'
  if (l.patch !== c.patch) return 'patch'
  return 'none'
}
function repoFlag(name) {
  const u = usage
  switch (name) {
    case 'tsdown': return `tsdownConfigPath=${u.tsdownConfigPath ?? '(unknown)'}; format=esm; platform=node; noExternal=/.*/`
    case '@antfu/eslint-config': return `eslintConfigPath=${u.eslintConfigPath ?? '(unknown)'}; uses antfu({type:'app',stylistic:true,ignores:[...]})`
    case 'eslint': return `flat config via @antfu/eslint-config v7`
    case 'knip': return u.hasKnipConfig ? 'has knip config file' : 'no knip config — relies on defaults via knip-bun script'
    case 'undici': return 'imported directly in src/ — used for HTTP client + proxy plumbing'
    case 'typescript': return `tsc --noEmit gate; strict + verbatimModuleSyntax + ESNext`
    case 'bumpp': return 'used by release:patch/minor/major scripts (commit + tag)'
    case 'lint-staged': return 'wired into simple-git-hooks pre-commit'
    case 'elysia':
    case '@elysiajs/cors':
    case '@elysiajs/node':
      return 'HTTP server + Node fallback; route code must stay Bun/Node portable'
    case 'zod': return 'all request/response schemas validated via Zod v4'
    case 'citty': return 'CLI entry — start subcommand is contractual'
    case 'consola': return 'logger only — low blast radius'
    case 'gpt-tokenizer': return 'token counting on request path'
    case 'fetch-event-stream': return 'SSE parsing on translation path'
    case 'proxy-from-env': return 'proxy URL resolution'
    case '@types/bun': case '@types/proxy-from-env': return 'types only — type-check fallout only'
    default: return ''
  }
}

// ---------- Phase 1: Discover ----------
phase('Discover')
log(`Got ${outdated.length} outdated entries. dist-tags collected for ${Object.keys(distTags).length} packages.`)

// ---------- Phase 2: Classify ----------
phase('Classify')
const classified = outdated.map(r => ({ ...r, tier: classify(r), repoFlag: repoFlag(r.name) }))
const buckets = {
  patch: classified.filter(r => r.tier === 'patch'),
  minor: classified.filter(r => r.tier === 'minor'),
  pre1Minor: classified.filter(r => r.tier === 'pre1-minor'),
  major: classified.filter(r => r.tier === 'major'),
  pre1Major: classified.filter(r => r.tier === 'pre1-major'),
  other: classified.filter(r => !['patch', 'minor', 'pre1-minor', 'major', 'pre1-major'].includes(r.tier)),
}
log(`Tiers — patch:${buckets.patch.length} minor:${buckets.minor.length} pre1-minor:${buckets.pre1Minor.length} major:${buckets.major.length} pre1-major:${buckets.pre1Major.length} other:${buckets.other.length}`)

// Things that need research = anything that's not a clean patch, optionally filtered by args.only.
const allNonPatch = [...buckets.minor, ...buckets.pre1Minor, ...buckets.major, ...buckets.pre1Major]
const needsResearch = onlyFilter ? allNonPatch.filter(r => onlyFilter.has(r.name)) : allNonPatch
if (onlyFilter) log(`args.only filter active — researching ${needsResearch.length}/${allNonPatch.length} non-patch packages: ${[...onlyFilter].join(', ')}`)

// ---------- Phase 3: Research (pipeline) ----------
// Each dep goes through:
//   3a) fetch changelog excerpt for [current, latest]
//   3b) extract breaking changes + map to this repo's usage surface
//   3c) score: safe / review / blocked
// Stages run independently per item — no barrier — slow deps don't block fast ones.

const FINDING_SCHEMA = {
  type: 'object',
  required: ['breaking', 'newRequirements', 'migrationSteps', 'engineLayerFindings'],
  properties: {
    breaking: {
      type: 'array',
      items: {
        type: 'object',
        required: ['version', 'change', 'affectsRepo', 'affectsRepoEvidence'],
        properties: {
          version: { type: 'string' },
          change: { type: 'string', minLength: 8 },
          affectsRepo: { type: 'boolean' },
          affectsRepoEvidence: { type: 'string' },
        },
      },
    },
    newRequirements: { type: 'array', items: { type: 'string' } },
    migrationSteps: { type: 'array', items: { type: 'string' } },
    engineLayerFindings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['source', 'change', 'affectsRepo', 'affectsRepoEvidence'],
        properties: {
          source: { type: 'string', description: 'Which underlying engine and version this change comes from, e.g. "rolldown 1.1.0", "oxc-parser 0.x"' },
          change: { type: 'string' },
          affectsRepo: { type: 'boolean' },
          affectsRepoEvidence: { type: 'string' },
        },
      },
      description: 'Required when args.bundlerContext mentions this package. Map each engine-layer item the user supplied to a concrete repo-impact judgement. Empty array means "I checked and none apply"; the verify phase will refute any unjustified emptiness.',
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['tier', 'confidence', 'rationale', 'preflightChecks'],
  properties: {
    tier: { enum: ['safe', 'review', 'blocked'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string', minLength: 20 },
    preflightChecks: { type: 'array', items: { type: 'string' }, description: 'concrete commands to run before merging this bump' },
  },
}

function changelogPrompt(row) {
  const engineCtx = bundlerContext[row.name]
  const engineSection = engineCtx
    ? `

ENGINE-LAYER CONTEXT (caller-supplied — you MUST address every bullet in engineLayerFindings):
${engineCtx}

For each engine-layer bullet above, emit one engineLayerFindings entry with source/change/affectsRepo/affectsRepoEvidence. If you believe the bullet does not apply, still emit it with affectsRepo:false and concrete evidence (file path, config flag value, grep result). The verify phase will refute any empty engineLayerFindings array when this section is present.`
    : ''

  return `You are researching a dependency upgrade. Use ONLY web fetches and the Context7 MCP if available. Do NOT speculate from memory.

Package: ${row.name}
Current: ${row.current}
Target (latest): ${row.latest}
Tier: ${row.tier}
Repo usage signal: ${row.repoFlag || '(none recorded)'}${engineSection}

Tasks:
1. Find this package's CHANGELOG (try, in order: GitHub repo /raw/main/CHANGELOG.md, /releases pages, npm package page, Context7). For monorepo packages (@elysiajs/*, @antfu/*) the changelog usually lives at the repo root.
2. Enumerate EVERY breaking change between ${row.current} and ${row.latest} (exclusive→inclusive). Do not skip intermediate majors/minors.
3. For each breaking change, judge whether this repo is affected based on the usage signal. Be concrete — quote the file path or API in affectsRepoEvidence.
4. ${engineCtx ? 'For every ENGINE-LAYER CONTEXT bullet above, emit an engineLayerFindings entry with a concrete repo-impact judgement and evidence.' : 'If the package has an underlying engine (e.g. tsdown→rolldown, eslint-config→@typescript-eslint), include the engine-layer behavior changes in engineLayerFindings.'}
5. List new minimum runtime requirements (Node X, Bun Y, TypeScript Z, ESM-only, etc.).
6. List concrete migration steps the user must do BEFORE the bump, in order.

Return ONLY via the StructuredOutput tool matching the provided schema. Empty arrays are fine only when justified; do not invent breaking changes that don't exist.`
}

function verifyPrompt(row, finding) {
  const engineCtx = bundlerContext[row.name]
  const engineSection = engineCtx
    ? `

ENGINE-LAYER CONTEXT the finder was supposed to address (refute any empty / hand-wavy engineLayerFindings):
${engineCtx}`
    : ''

  return `Adversarial verification. Another agent claims the following about bumping ${row.name} from ${row.current} to ${row.latest}:

${JSON.stringify(finding, null, 2)}

Repo usage signal: ${row.repoFlag || '(none recorded)'}${engineSection}

Your job is to REFUTE the claim that this bump is safe for this repo. Default to refuting if uncertain. Specifically check:
  - Did the finding miss a breaking change in any intermediate version?
  - Did it under-rate "affectsRepo" — e.g. claim no impact but the API IS used (search the repo via Grep if you can)?
  - Are there transitive peer-dep conflicts (eslint X requires @typescript-eslint Y, etc.)?
  - For tsdown: did it miss a Rolldown-backend change (lazyBarrel/inlineConst defaults, CJS interop output naming, chunk hashing, sourcemap layout, define semantics, noExternal regex behavior, plugin API shape)? Cross-check the ENGINE-LAYER CONTEXT bullets one by one.
  - For @antfu/eslint-config: ESLint major + Node version floor + flat-config rule renames + bundled @typescript-eslint / unicorn / import-lite peers?
  - For knip: config schema or default-include changes that would break the existing \`knip\` script?
  - For undici: fetch/Headers/Agent surface changes that affect proxy plumbing?
  - For typescript: \`verbatimModuleSyntax\`, module resolution, lib changes, declaration emit?

Then output your final tier:
  - safe    = no plausible refutation; can ship in the safe-batch
  - review  = some real risk; needs human sign-off but not blocked
  - blocked = will break the repo as-is; needs code change first
Include concrete preflightChecks (bash commands) — at minimum a relevant subset of: bun install / bun run lint:all / bun run typecheck / bun test / bun run build / bun run smoke:packaged.`
}

const researched = await pipeline(
  needsResearch,
  // 3a + 3b: combined into one structured agent call
  row => agent(changelogPrompt(row), {
    label: `research:${row.name}`,
    phase: 'Research',
    schema: FINDING_SCHEMA,
  }).then(finding => ({ row, finding })),
  // 3c: adversarial verify — 3 independent skeptics, majority refute → downgrade
  async ({ row, finding }, _orig, _idx) => {
    if (!finding) return { row, finding: null, verdict: null, votes: [] }
    const votes = await parallel(
      Array.from({ length: 3 }, (_, i) => () =>
        agent(`Skeptic #${i + 1}. ${verifyPrompt(row, finding)}`, {
          label: `verify:${row.name}#${i + 1}`,
          phase: 'Verify',
          schema: VERDICT_SCHEMA,
        }),
      ),
    )
    const live = votes.filter(Boolean)
    // Conservative aggregation: worst tier wins if 2+ agree; otherwise the modal tier.
    const tally = { safe: 0, review: 0, blocked: 0 }
    for (const v of live) tally[v.tier] = (tally[v.tier] ?? 0) + 1
    let tier = 'review'
    if (tally.blocked >= 2) tier = 'blocked'
    else if (tally.blocked === 1 && tally.review >= 1) tier = 'review'
    else if (tally.review >= 2) tier = 'review'
    else if (tally.safe >= 2 && tally.blocked === 0) tier = 'safe'
    const avgConf = live.length ? live.reduce((s, v) => s + (v.confidence ?? 0.5), 0) / live.length : 0
    const rationales = live.map((v, i) => `#${i + 1} (${v.tier}, conf ${v.confidence?.toFixed?.(2) ?? '?'}): ${v.rationale}`)
    const preflight = Array.from(new Set(live.flatMap(v => v.preflightChecks ?? [])))
    return {
      row,
      finding,
      verdict: { tier, confidence: avgConf, rationales, preflightChecks: preflight, tally },
      votes: live,
    }
  },
)

// ---------- Phase 5: Synthesize ----------
phase('Synthesize')

const valid = researched.filter(Boolean).filter(r => r.finding && r.verdict)
const byTier = { safe: [], review: [], blocked: [] }
for (const r of valid) byTier[r.verdict.tier].push(r)

// Patch tier is always safe by definition — fold it in.
const safePatchRows = buckets.patch
const safeAll = [...safePatchRows.map(r => ({ row: r, finding: null, verdict: { tier: 'safe', confidence: 1, rationales: ['patch-level bump, no schema/API risk'], preflightChecks: ['bun install', 'bun run lint:all', 'bun run typecheck', 'bun test', 'bun run build'], tally: { safe: 0, review: 0, blocked: 0 } } })), ...byTier.safe]

// ---------- Generate command lists ----------
function bumpCmd(rows) {
  if (rows.length === 0) return '# (none)'
  const deps = rows.filter(r => (r.row?.kind ?? r.kind) === 'dep').map(r => `${r.row?.name ?? r.name}@${r.row?.latest ?? r.latest}`)
  const devs = rows.filter(r => (r.row?.kind ?? r.kind) === 'devDep').map(r => `${r.row?.name ?? r.name}@${r.row?.latest ?? r.latest}`)
  const lines = []
  if (deps.length) lines.push(`rtk bun add ${deps.join(' ')}`)
  if (devs.length) lines.push(`rtk bun add -d ${devs.join(' ')}`)
  return lines.join('\n') || '# (none)'
}

function md() {
  const lines = []
  lines.push('# Dependency Upgrade Plan')
  lines.push('')
  lines.push('_Generated by the `upgrade-deps` workflow. Do not hand-edit — regenerate._')
  lines.push('')
  lines.push('## TL;DR')
  lines.push('')
  lines.push(`- safe (patch + verified): **${safeAll.length}**`)
  lines.push(`- review (needs human eyeballs before merge): **${byTier.review.length}**`)
  lines.push(`- blocked (needs code change first): **${byTier.blocked.length}**`)
  lines.push('')
  lines.push('Run safe batch in one PR, review batch as a second PR (one commit per dep so reverts are surgical), and address blocked batch one at a time.')
  lines.push('')

  lines.push('## Outdated table')
  lines.push('')
  lines.push('| Package | Current | Update | Latest | Tier | Repo usage |')
  lines.push('|---|---|---|---|---|---|')
  for (const r of classified) {
    lines.push(`| \`${r.name}\` | ${r.current} | ${r.update} | ${r.latest} | ${r.tier} | ${r.repoFlag.replaceAll('|', '\\|') || '—'} |`)
  }
  lines.push('')

  function section(title, items, includeFinding) {
    lines.push(`## ${title}`)
    lines.push('')
    if (items.length === 0) {
      lines.push('_(none)_')
      lines.push('')
      return
    }
    lines.push('### Bump commands')
    lines.push('')
    lines.push('```bash')
    lines.push(bumpCmd(items))
    lines.push('```')
    lines.push('')
    if (includeFinding) {
      lines.push('### Per-package details')
      lines.push('')
      for (const r of items) {
        const name = r.row?.name ?? r.name
        const cur = r.row?.current ?? r.current
        const lat = r.row?.latest ?? r.latest
        lines.push(`#### \`${name}\` ${cur} → ${lat}`)
        lines.push('')
        if (r.verdict) {
          const tallyJson = r.verdict.tally ? `{safe:${r.verdict.tally.safe ?? 0}, review:${r.verdict.tally.review ?? 0}, blocked:${r.verdict.tally.blocked ?? 0}}` : '{}'
          lines.push(`- **Verdict tier**: ${r.verdict.tier} (avg confidence ${r.verdict.confidence.toFixed(2)}, tally ${tallyJson})`)
          if (r.verdict.rationales?.length) {
            lines.push('- **Skeptic rationales**:')
            for (const x of r.verdict.rationales) lines.push(`  - ${x}`)
          }
          if (r.verdict.preflightChecks?.length) {
            lines.push('- **Preflight checks**:')
            for (const x of r.verdict.preflightChecks) lines.push(`  - \`${x}\``)
          }
        }
        if (r.finding) {
          if (r.finding.newRequirements?.length) {
            lines.push('- **New requirements**:')
            for (const x of r.finding.newRequirements) lines.push(`  - ${x}`)
          }
          if (r.finding.engineLayerFindings?.length) {
            lines.push('- **Engine-layer findings**:')
            for (const f of r.finding.engineLayerFindings) {
              const mark = f.affectsRepo ? '⚠️ AFFECTS REPO' : '✅ not used here'
              lines.push(`  - [${f.source}] ${f.change} — ${mark} — _${f.affectsRepoEvidence}_`)
            }
          }
          if (r.finding.breaking?.length) {
            lines.push('- **Breaking changes**:')
            for (const b of r.finding.breaking) {
              const mark = b.affectsRepo ? '⚠️ AFFECTS REPO' : '✅ not used here'
              lines.push(`  - ${b.version} — ${b.change} — ${mark} — _${b.affectsRepoEvidence}_`)
            }
          }
          if (r.finding.migrationSteps?.length) {
            lines.push('- **Migration steps**:')
            for (const x of r.finding.migrationSteps) lines.push(`  - ${x}`)
          }
        }
        lines.push('')
      }
    }
  }

  section('Safe batch — ship in one PR', safeAll, true)
  section('Review batch — one commit per dep, request review', byTier.review, true)
  section('Blocked batch — code change required first', byTier.blocked, true)

  lines.push('## Preflight (full local CI parity)')
  lines.push('')
  lines.push('```bash')
  lines.push('rtk bun install')
  lines.push('rtk bun run lint:all && rtk bun run typecheck && rtk bun test && rtk bun run build && rtk bun run smoke:packaged')
  lines.push('```')
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- `tsdown` is still pre-1.0 (latest stable `0.22.2`). v0.22.0 introduced 3 hard breakings (Node ≥22.18 floor, `dts` auto-enables when `tsconfig.declaration:true`, `publint` ≥0.3.8 required) and bumped the underlying bundler to **Rolldown 1.x stable**.')
  lines.push('- **Rolldown 1.0.0** shipped 2026-05-07; **1.1.0** shipped 2026-06-03 (tsdown 0.22.2 pins `~1.1.0`). 1.1.0 enables `experimental.lazyBarrel` by default — barrel re-exports judged side-effect-free are dropped. With `noExternal: /.*/` this repo bundles every transitive module; if any of them rely on a barrel re-export for side-effects, output will silently lose code.')
  lines.push('- This repo bundles **everything** (`noExternal: /.*/`) so any Rolldown change to ESM interop output, chunk hashing, sourcemap layout, or `__toESM` injection has full blast radius into `dist/main.mjs`. `bun run smoke:packaged` (runs the packaged CLI under Node) is the only gate that catches this — always run it after a tsdown bump.')
  lines.push('- ESLint flat-config bumps must go in lockstep with `@antfu/eslint-config` — never split them.')
  lines.push('- `bun outdated` may pin a sub-latest "Update" column when peerDeps disagree; always use the workflow\'s `Latest` column as the target.')
  return lines.join('\n')
}

const report = md()
log(`Plan summary — safe ${safeAll.length} | review ${byTier.review.length} | blocked ${byTier.blocked.length}`)
log(`Report would be written to ${reportPath} by the caller (workflows are sandboxed; no filesystem writes).`)

return {
  reportPath,
  reportMarkdown: report,
  safeBatch: safeAll.map(r => ({ name: r.row?.name ?? r.name, current: r.row?.current ?? r.current, latest: r.row?.latest ?? r.latest, kind: r.row?.kind ?? r.kind })),
  reviewBatch: byTier.review.map(r => ({ name: r.row.name, current: r.row.current, latest: r.row.latest, kind: r.row.kind, finding: r.finding, verdict: r.verdict })),
  blockedBatch: byTier.blocked.map(r => ({ name: r.row.name, current: r.row.current, latest: r.row.latest, kind: r.row.kind, finding: r.finding, verdict: r.verdict })),
  bumpCommands: {
    safe: bumpCmd(safeAll),
    review: bumpCmd(byTier.review),
    blocked: bumpCmd(byTier.blocked),
  },
  classifiedRaw: classified,
}
