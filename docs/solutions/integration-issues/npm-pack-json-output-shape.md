---
title: "npm pack --json output shape differs across npm major versions"
date: 2026-07-25
last_updated: 2026-07-29
category: integration-issues
module: scripts/smoke/packaged-cli
problem_type: test_failure
component: testing_framework
symptoms:
  - "smoke:packaged fails with 'JSON Parse error: Unable to parse JSON string' at packaged-cli.ts"
  - "extractTrailingJson returns a mid-object fragment when npm pack --json emits an object"
root_cause: wrong_api
resolution_type: test_fix
severity: medium
related_components:
  - "tooling"
  - "development_workflow"
tags:
  - "npm-pack"
  - "smoke-test"
  - "npm-version"
  - "ci-publish-gate"
---

# npm pack --json output shape differs across npm major versions

## Problem

The packaged-CLI smoke test (`bun run smoke:packaged`) failed at the JSON-parse
step because `npm pack --json` returns a different top-level shape depending on
the installed npm major version.

## Symptoms

- `bun run smoke:packaged` throws `SyntaxError: JSON Parse error: Unable to parse JSON string` at `scripts/smoke/packaged-cli.ts` where the pack manifest is parsed.
- The failure reproduces on unmodified `main` under npm 12, so it presents as a pre-existing environment issue rather than a regression from any code change.

## What Didn't Work

- **Blaming a local packaging change.** The failure surfaced while narrowing `package.json` `files` to exclude source maps, so the first assumption was that the `files` change broke packing. Checking out `main`'s `package.json` and re-running reproduced the same parse error — the shape mismatch is independent of what gets packed.
- **Treating it as purely an environment quirk.** The smoke also hit a downstream `E401` on `npm install` (a private Azure DevOps default registry with a stale token), which masked the real defect. The auth error is genuinely environmental and CI-irrelevant, but the *parse* failure underneath it is a real script bug.

## Solution

`npm pack --json` changed its top-level shape between major versions:

- **npm <= 11** returns an array: `[{ "filename": "pkg-1.0.0.tgz", ... }]`
- **npm 12** returns an object keyed by package name: `{ "pkg": { "filename": "pkg-1.0.0.tgz", ... } }`

The npm 12 object embeds a nested `"files": [` array. The old parser used
`extractTrailingJson`, which only knows how to locate a *trailing array* — it
did `lastIndexOf('[\n')`, sliced from the inner `files` bracket, and produced a
broken mid-object fragment that failed `JSON.parse`.

Fix: parse the decoded stdout directly (it is already clean JSON under
`--silent`), keep the trailing-JSON heuristic only as a fallback for runners
that prepend noise, and normalize both shapes to an array before reading
`[0].filename`.

```ts
// scripts/smoke/packaged-cli.ts
// Before: array-only, fails on npm 12
const packOutput = extractTrailingJson(decodeOutput(packResult.stdout))
const parsed = JSON.parse(packOutput) as Array<NpmPackResult>
const tarballName = parsed[0]?.filename

// After: shape-agnostic
const rawStdout = decodeOutput(packResult.stdout).trim()
const parsedRaw = (tryParseJsonOrUndefined(rawStdout)
  ?? JSON.parse(extractTrailingJson(rawStdout))) as
  | Array<NpmPackResult>
  | Record<string, NpmPackResult>
const parsed = Array.isArray(parsedRaw) ? parsedRaw : Object.values(parsedRaw)
const tarballName = parsed[0]?.filename
```

## Why This Works

`npm pack --json --silent` writes clean JSON to stdout, so parsing it directly
is correct in the common case and sidesteps the array-only assumption baked into
`extractTrailingJson`. Normalizing with `Array.isArray(x) ? x : Object.values(x)`
handles both npm's historical array shape and npm 12's name-keyed object, so the
same code works whatever npm the CI runner or a contributor's machine ships.

## Prevention

- **Never assume a CLI's `--json` output shape is stable across major versions.** Normalize array-vs-object at the boundary rather than casting to one shape.
- **Beware `npm pack --json` stdout pollution from lifecycle scripts.** This repo's `prepack` runs `tsdown`, whose progress logs go to **stdout** and corrupt `--json` parsing; npm's own file listing goes to **stderr**. When you only need the packed file list (not a filename), read the stderr listing instead of `--json`. The release-npm CD "Verify tarball ships no source maps" guard relies on this: it greps `npm pack --dry-run 2>&1 >/dev/null` for `dist/*.map` rather than parsing `--json`.
- **Distinguish a real script bug from an environmental blocker when a smoke fails.** Here two failures stacked: the JSON-parse bug (real, CI-relevant) and an `E401` from a private default registry (environmental, CI-irrelevant). Reproduce on a clean checkout to separate them before concluding "pre-existing / not my change."

## Related

- `docs/solutions/conventions/upstream-types-are-not-contract-evidence.md` — the
  same rule applied to an HTTP API rather than a CLI: an external contract we did
  not verify is an assumption, whatever shape our own code assumes it has.
- `docs/solutions/testing/green-suite-is-evidence-about-one-runtime.md` — the
  same defect where the second implementation is a runtime rather than a CLI
  major. This one failed loudly: npm 12's object shape crashed the parser on
  first contact. A wrong branch in a classifier stays green until production.
