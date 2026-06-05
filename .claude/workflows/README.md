# `.claude/workflows/`

Self-contained [Claude Code Workflow](https://docs.claude.com/en/docs/claude-code/workflows) scripts checked into the repo. Run via the `Workflow` tool from a Claude Code session:

```text
Workflow({ scriptPath: ".claude/workflows/<script>.js", args: { ... } })
```

These are not part of the runtime, lint, or test surface. They are author-time tooling for periodic chores that benefit from fan-out + adversarial verification (deeper than a single agent can cover in one pass).

## `upgrade-deps.js`

Audits outdated npm dependencies, fetches each package's changelog, maps the breaking changes against this repo's actual usage surface, and produces a tiered upgrade plan (safe / review / blocked) with adversarial verification (3 skeptics per non-patch bump, majority refute → downgrade).

### Inputs (`args`)

| Field | Required | Description |
|---|---|---|
| `outdated` | yes | Rows from `bun outdated` — `[{ name, current, update, latest, kind: 'dep'\|'devDep' }, ...]` |
| `distTags` | no | `{ [pkg]: { latest, beta?, next?, ... } }` from `bun pm view <pkg> dist-tags` — surfaces RC/beta channels |
| `usageHints` | no | Repo-specific context (`tsdownConfigPath`, `eslintConfigPath`, `hasKnipConfig`, `lintScriptUsesESLintFlat`) so the research agent knows which usage signals matter |
| `bundlerContext` | no | `{ [pkg]: '<free-text>' }` — engine-layer / underlying-tool breaking changes the workflow must reconcile against. For tsdown, pass a rolldown summary (lazyBarrel, inlineConst.mode, CJS interop). The research agent is required to map every bullet to a concrete repo-impact judgement. |
| `only` | no | `['pkgA', 'pkgB']` — limit research to these names (patch-tier still folded into safeBatch) |
| `reportPath` | no | Defaults to `docs/upgrade-plan.md` (the workflow does not write — it returns the markdown for the caller to persist) |

### Outputs

```ts
{
  reportPath: string,
  reportMarkdown: string,     // full plan; pipe through scripts/extract-workflow-report.ts to persist
  safeBatch:   Array<{ name, current, latest, kind }>,
  reviewBatch: Array<{ name, current, latest, kind, finding, verdict }>,
  blockedBatch: Array<{ name, current, latest, kind, finding, verdict }>,
  bumpCommands: { safe: string, review: string, blocked: string },
  classifiedRaw: Array<...>,
}
```

### Typical run

```bash
# 1. Collect the inputs
bun outdated                                    # → parse into args.outdated
bun pm view <pkg> dist-tags                     # → args.distTags
# (Optional) For deps with an underlying engine, fetch its CHANGELOG / release notes
# and stuff a free-text summary into args.bundlerContext[depName].
```

```text
# 2. Run the workflow from a Claude Code session
Workflow({ scriptPath: ".claude/workflows/upgrade-deps.js", args: { outdated, distTags, usageHints, bundlerContext } })
```

```bash
# 3. Persist the structured result to docs/upgrade-plan.md
bun run scripts/extract-workflow-report.ts <workflow-task-output-path>
```

A worked example of the output lives at `docs/upgrade-plan.md`.

### When NOT to use

- `bun outdated` shows only patch bumps — just run them.
- You only want to bump ONE package and you already know its changelog — direct edit is faster.

### Why not just a `bun run` script?

The workflow fans out ~10 research agents in parallel (one per non-patch dep) and ~30 skeptic agents (3 per finding) to refute the "safe to ship" claim. A single sequential agent misses cross-cutting peer-dep conflicts (e.g. tsdown's `typescript ^5.0.0` peer blocking a typescript@6 bump). The structured-output schema forces each finding to cite `file:line` evidence, which is what makes the resulting plan auditable.

A previous run skipped passing `bundlerContext` for tsdown and rated the bump `safe` based on tsdown's own changelog alone — re-running with rolldown 1.0/1.1 context downgraded it to `review` because the underlying engine introduced `experimental.lazyBarrel = true` by default, which silently drops side-effecting barrel re-exports under this repo's `noExternal: /.*/` bundling strategy. The bundlerContext field exists specifically to prevent that class of false-positive.
