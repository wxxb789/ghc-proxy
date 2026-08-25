# AGENTS.md

> **Convention**: `CLAUDE.md` in this repo is a **symlink → `AGENTS.md`** (git
> mode `120000`). Same applies to every nested `**/CLAUDE.md`. Edit
> `AGENTS.md` only; never `Write`/`Edit` `CLAUDE.md` (it would replace the
> symlink with a regular file on Windows). Recreation recipe at the bottom.

This file is for agentic coding tools (Claude Code, Codex, Cursor, GitHub
Copilot, etc.) working in this repository.

## Project Overview

ghc-proxy is a reverse-engineered API translation proxy that converts GitHub Copilot's API into OpenAI- and Anthropic-compatible formats. It enables Claude Code, Cursor, and any OpenAI/Anthropic-speaking client to use a GitHub Copilot subscription. **Unofficial, may break at any time.**

- **Runtime:** Bun >= 1.3 (first-class), Node.js >= 24 LTS compatible via `@elysiajs/node` fallback
- **Language:** TypeScript (ESNext, strict mode)
- **Framework:** Elysia (HTTP server), citty (CLI), Zod (validation)
- **Published as:** `ghc-proxy` npm package (`dist/main.mjs` entry plus generated
  `.mjs` dynamic chunks; `package.json#files` ships the complete import graph)

## Commands

```bash
bun install                          # Install dependencies (frozen lockfile in CI)
bun run dev                          # Start with --watch (hot reload)
bun run build                        # Build dist/main.mjs plus dynamic chunks
bun run lint                         # ESLint with cache
bun run lint:all                     # ESLint full scan (used in CI)
bun run typecheck                    # tsc --noEmit
bun test                             # Run all tests (Bun native test runner)
bun test tests/validation.test.ts    # Run a single test file
bun test tests/contract-smoke.test.ts # Publish gate for public schema compatibility
bun run start                        # Production server (NODE_ENV=production)
bun run matrix:live                  # End-to-end Copilot upstream check (uses real quota — do not use as a sanity check)
bun run smoke:packaged               # Smoke test the packaged CLI (selfcheck under bun + node)
bun run release:patch                # Bump patch, commit, tag, and push (bumpp 11 pushes branch + tag automatically)
```

**CI topology:** `.github/workflows/ci.yml` runs `lint`, `typecheck`, `test`, and
`build` as independent jobs. The `build` job runs `build` then
`smoke:packaged`; there is no cross-job execution order.

**Local full gate:** `bun run lint:all && bun run typecheck && bun test --path-ignore-patterns='**/token-file-removal.test.ts' --path-ignore-patterns='**/token-refresh-retry.test.ts' && bun test tests/token-file-removal.test.ts tests/token-refresh-retry.test.ts && bun run build && bun run smoke:packaged`.
The `/verify` skill carries the same command in a readable multi-line form.

## Compatibility Contract

All public ghc-proxy endpoints must match the official client-facing schema they expose.

- OpenAI-facing routes stay OpenAI-compatible at the proxy boundary.
- Anthropic-facing routes stay Anthropic-compatible at the proxy boundary.
- Copilot-specific quirks are handled **inside** the proxy via normalization, validation, routing, or translation — never leaked outward.

## Architecture (overview)

```text
Client → Guard → Ingest → Transform → Dispatch → Deliver → Client
                 (parse)  (model chain) (strategy) (SSE/JSON)
```

Route plugins live under `src/routes/<endpoint>/`; their internal shape follows
the endpoint. Simple endpoints use `route.ts` + `handler.ts`. Strategy-backed
endpoints add a strategy and registry, while Messages keeps its strategies
under `strategies/` and Responses also has resource/emulator modules.

`src/server.ts` is the route-registration source of truth:

- Chat Completions, Models, Embeddings, and all Responses create, input-token,
  and resource routes are available both at the root and under `/v1`.
- Messages and Messages count-tokens are `/v1`-only.
- `/token` and `/usage` are root-only proxy routes.
- Health and the Dashboard assets/APIs are root-only; Dashboard access is
  enforced by its route guard.

`/v1/messages` has three execution strategies the registry picks between per model: **Native Messages** (direct passthrough), **Responses Translation** (Anthropic → Responses → Anthropic), and **Chat Completions Fallback** (Anthropic → OpenAI Chat → Anthropic).

For everything beyond this overview, start with `docs/design/README.md`, then
read the relevant design docs:

- `docs/design/execution-strategy.md` — strategy pattern and error handling
- `docs/design/model-routing.md` — model pipeline and fallback/rewrite mechanics
- `docs/design/translation-pipeline.md` — full translation pipeline
- `docs/messages-routing-and-translation.md` — `/v1/messages` routing logic
- `docs/anthropic-translation-matrix.md` — translation coverage
- `docs/solutions/` — documented solutions to past problems (bugs, conventions, patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.
- `CONCEPTS.md` — shared domain vocabulary (proxy boundary, execution strategies, routing terms). Read when orienting to the codebase or before discussing domain concepts.

When making architectural changes, update the relevant design doc in the same change.

## Adding a New Route

1. Copy the nearest endpoint shape under `src/routes/`; do not add a strategy
   layer unless the endpoint needs model-dependent dispatch.
2. For strategy-backed endpoints, implement `ExecutionStrategy` and register it
   in that endpoint's `StrategyRegistry`.
3. Register the route plugin in `src/server.ts` at the contractually correct
   root and/or `/v1` surface.
4. Add route and contract tests; keep
   `bun test tests/contract-smoke.test.ts` passing.

If the route translates between protocols, add an entry to `docs/anthropic-translation-matrix.md` so coverage stays auditable.

## Code Conventions

- **Imports:** ESNext only. Use `~/*` path alias for `src/*`. Prefer index exports (`~/clients`, `~/types`, `~/translator`). Use `import type` where possible.
- **Style:** `@antfu/eslint-config` flat config. `bun run lint --fix` auto-fixes most issues.
- **Types:** Strict TypeScript. No `any`. No unused locals/parameters. No switch fallthrough. `verbatimModuleSyntax` enabled.
- **Naming:** `camelCase` for variables/functions, `PascalCase` for types/classes.
- **Errors:** Explicit error classes in `src/lib/error.ts` (`HTTPError`, `throwInvalidRequestError`). No silent failures.
- **Logging:** `consola` for human-readable output. For machine-readable output (e.g. `--json`), write clean data directly to stdout.
- **CLI:** `start` must remain an explicit subcommand. No default command.
- **Complexity:** Favor direct implementation over unnecessary abstractions. Three similar lines is better than a premature helper.
- **Scope discipline:** Fix only the issue the change targets. Don't refactor pre-existing duplication or "while you're there" — small, focused diffs review better and revert cleaner.
- **Runtime APIs:** Bun-native APIs (`Bun.file`, `Bun.serve`, `Bun.sleep`, etc.) are fine in `scripts/` and `tests/`. **Route code under `src/` must work on both Bun and Node** — use Web/Node standard APIs (`fetch`, `Response`, `crypto.subtle`, etc.). `smoke:packaged` packs the npm artifact and runs tokenizer and runtime-contract selfchecks under both runtimes. The unit suite still runs only under Bun, so add a Node-shaped fixture when the risk is not covered by those probes; see `docs/solutions/testing/green-suite-is-evidence-about-one-runtime.md`.

## Testing

See `tests/AGENTS.md` for the test-runner conventions, helper inventory, and fixture patterns.

## Don't / Gotchas

- **`dist/` is build output.** Never hand-edit; `bun run build` regenerates the
  entry module, dynamic `.mjs` chunks, and source maps from `src/`.
- **`bun run matrix:live` burns real Copilot quota.** Don't run it as a sanity check; use `bun test` or `bun run smoke:packaged` instead.
- **`shouldUse*()` helpers are legacy.** New feature-flag queries go through `ConfigStore` (`src/state/config-store.ts`). Don't add new `shouldUse*` call sites.
- **Don't silently drop unsupported fields in translators.** Use `TranslationPolicy` to mark behavior `exact`/`lossy`/`unsupported`; validation returns 400 for `unsupported`. Silent drops mask client bugs and bite later.
- **Conventional commits.** `fix:`, `feat:`, `docs:`, `chore:`, `refactor:`, `test:`. Squash-merge to `main` preserves the prefix in history.
- **Don't bypass `simple-git-hooks` with `--no-verify`.** If `lint-staged` complains, fix the lint — don't skip it.

## Pre-commit Hooks

`simple-git-hooks` runs `lint-staged`, which runs `bun run lint --fix` on staged files.

## Branch & PR Workflow

- Feature branches with PRs; squash-merge into `main`.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`wxxb789/ghc-proxy`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary; label strings equal the role names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONCEPTS.md` (glossary) + `docs/design/` (decisions) + `docs/solutions/` (past problems). See `docs/agents/domain.md`.

## Release Automation

- **Tag-triggered pipeline:** `.github/workflows/release-npm.yml` handles ordered
  validation, package checks, changelog generation, and npm publish in one job.
- **Version contract:** Workflow validates `vX.Y.Z` matches `package.json` `version` before publish.
- **Auth model:** npm Trusted Publishing (GitHub OIDC). No long-lived npm tokens.
- **Typical flow:** `bun run release:patch` (or `:minor` / `:major`) bumps the version, commits, tags, and pushes branch + tag in one step (bumpp 11 default). The pushed tag triggers `.github/workflows/release-npm.yml`, which validates and publishes.
- **Immutability:** npm rejects republishing an existing version. Always bump before tagging.

## Agent Instruction File Symlink (Windows-safe recipe)

`CLAUDE.md` is a git symlink (mode `120000`) pointing to `AGENTS.md`. The
same convention applies to every nested directory: any `**/CLAUDE.md` is a
symlink to the `AGENTS.md` in the **same** directory. See
`docs/solutions/conventions/agent-instruction-symlink.md` for the rationale
and the footguns this avoids.

### Golden rule

**Edit `AGENTS.md` only.** Never `Write`/`Edit` `CLAUDE.md` — on Windows
that replaces the symlink with a regular file and the two files drift again.

### Recreating a symlink (if it gets clobbered)

```bash
# 1. Pick the clobbered path. For nested files, the target is still AGENTS.md
#    because each CLAUDE.md points to the AGENTS.md in the same directory.
path=CLAUDE.md              # or tests/CLAUDE.md, docs/foo/CLAUDE.md, etc.

# 2. Write target path as file content (no trailing newline)
printf 'AGENTS.md' > "$path"

# 3. Create blob WITHOUT trailing newline and register as symlink (mode 120000)
git update-index --add --cacheinfo \
  120000,$(printf 'AGENTS.md' | git hash-object -w --stdin),"$path"

# 4. Checkout to materialize the OS-level symlink
git checkout -- "$path"

# 5. Verify
git ls-files -s "$path"     # must show mode 120000
```

Do NOT use `ln -s` (Git Bash on Windows silently makes a copy), `cp`, or
here-strings (`<<<`) with `git hash-object` (they append `\n` and break the
target).

### After a fresh clone on Windows

```bash
git config --local core.symlinks true
git ls-files -z 'CLAUDE.md' '**/CLAUDE.md' | xargs -0 git checkout --
git ls-files -s 'CLAUDE.md' '**/CLAUDE.md'   # all must show mode 120000
```
