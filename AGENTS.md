# AGENTS.md

> **Convention**: `CLAUDE.md` in this repo is a **symlink → `AGENTS.md`** (git
> mode `120000`). Edit `AGENTS.md` only; never `Write`/`Edit` `CLAUDE.md` (it
> would replace the symlink with a regular file on Windows). To regenerate the
> symlink, see the recipe at the bottom of this file.

This file provides guidance to agentic coding tools (Claude Code, Codex,
Cursor, GitHub Copilot, etc.) working in this repository.

## Project Overview

ghc-proxy is a reverse-engineered API translation proxy that converts GitHub Copilot's API into OpenAI and Anthropic compatible formats. It enables tools like Claude Code, Cursor, and any OpenAI/Anthropic-speaking client to use a GitHub Copilot subscription. **Unofficial, may break at any time.**

- **Runtime:** Bun >= 1.2 (first-class), Node.js compatible via `@elysiajs/node` fallback
- **Language:** TypeScript (ESNext, strict mode)
- **Framework:** Elysia (HTTP server, `@elysiajs/node` for Node.js runtime), citty (CLI), Zod (validation)
- **Published as:** `ghc-proxy` npm package (single-file CLI at `dist/main.mjs`)

## Commands

```bash
bun install                          # Install dependencies (frozen lockfile in CI)
bun run dev                          # Start with --watch (hot reload)
bun run build                        # Bundle with tsdown -> dist/main.mjs
bun run lint                         # ESLint with cache
bun run lint:all                     # ESLint full scan (used in CI)
bun run typecheck                    # tsc --noEmit
bun test                             # Run all tests (Bun native test runner)
bun test tests/validation.test.ts    # Run a single test file
bun test tests/api-smoke.test.ts     # Run API compatibility smoke tests (publish gate)
bun run start                        # Production server (NODE_ENV=production)
bun run matrix:live                  # End-to-end Copilot upstream compatibility (uses real quota)
bun run smoke:packaged               # Smoke test the packaged CLI
bun run release:patch                # Bump patch, commit, tag (then git push manually)
```

**CI pipeline runs:** lint:all → typecheck → test → build → smoke:packaged

**Validation after non-trivial changes:** `bun run lint:all && bun run typecheck && bun run build && bun test`

## Compatibility Contract

All public ghc-proxy endpoints must match the official client-facing schema they expose.

- OpenAI-facing routes must stay OpenAI-compatible at the proxy boundary.
- Anthropic-facing routes must stay Anthropic-compatible at the proxy boundary.
- Copilot-specific quirks must be handled inside the proxy via normalization, validation, routing, or translation.

## Architecture

### Request Flow

```text
Client Request → Elysia Route Handler → Zod Validation → Execution Strategy Selection → Adapter/Translator → Copilot Client → Response Translation → Client
```

### Three Execution Paths for `/v1/messages`

The proxy uses a per-model strategy pattern (`src/routes/messages/strategies/`) to choose the best upstream path:

1. **Native Messages** — Direct `/v1/messages` passthrough when Copilot supports it
2. **Responses Translation** — Anthropic → Responses → Anthropic when only `/responses` is available
3. **Chat Completions Fallback** — Anthropic → OpenAI Chat → Anthropic (legacy)

See `docs/messages-routing-and-translation.md` for routing logic and `docs/anthropic-translation-matrix.md` for translation coverage.

### Request Pipeline

Every route handler is a thin orchestrator of the 5-layer pipeline:

```
Guard → Ingest → Transform → Dispatch → Deliver
```

1. **Guard** (`src/guard/`) — Auth check and rate limiting, applied as an Elysia plugin.
2. **Ingest** (`src/ingest/`) — Protocol-specific parsing, Zod validation, and metadata extraction via `ProtocolRegistry`.
3. **Transform** (`src/transform/`) — Composable model transform chain (rewrite, beta-header processing, model policy). Messages route uses a 3-step chain; chat-completions and responses use single-step variants.
4. **Dispatch** (`src/dispatch/`) — Strategy selection via `StrategyRegistry`, execution, and config-driven error recovery (context-length retry with model upgrade). Messages route has 3 strategies; chat-completions and responses use single-strategy registries.
5. **Deliver** (`src/deliver/`) — Converts `ExecutionResult` into the HTTP response (SSE streaming or JSON serialization, error formatting, model mapping).

### Route File Pattern

Each route follows a consistent structure:

```
routes/<endpoint>/
├── route.ts          # Elysia route definition
├── handler.ts        # Parsing, validation, strategy dispatch
└── strategy.ts       # ExecutionStrategy implementation(s)
```

Messages route is more complex with multiple strategies in `strategies/` subdirectory.

### Key Modules

| Directory | Purpose |
|-----------|---------|
| `src/routes/` | HTTP route handlers (each route is self-contained) |
| `src/translator/anthropic/` | Anthropic ↔ OpenAI protocol translation with IR, normalization, and streaming transducers |
| `src/translator/responses/` | Anthropic ↔ Responses format translation with signature codec |
| `src/adapters/` | Protocol adapters (OpenAI Chat, Anthropic Messages, Copilot transport) |
| `src/clients/` | GitHub, Copilot, and VS Code API clients |
| `src/core/capi/` | Copilot API compatibility layer (plan builder, profiles, request context) |
| `src/core/conversation/` | Conversation state management |
| `src/lib/` | Utilities (state, config, tokens, errors, model resolution, rate limiting, validation) |
| `src/types/` | TypeScript type definitions |
| `src/state/` | Decomposed state stores (AuthStore, ModelCache, ConfigStore, RateLimiter, EmulatorStore) |
| `src/pipeline/` | Pipeline framework: `runPipeline()` orchestrator with lifecycle hooks, StrategyContext and ModelTransformResult types |
| `src/ingest/` | Protocol registry with per-protocol parsers and validators |
| `src/transform/` | Composable model transform chain (rewrite, beta-headers, policy steps) |
| `src/dispatch/` | Strategy registry, strategy runner, error recovery, ResourceDispatcher |
| `src/deliver/` | Response delivery (SSE, JSON, error formatting, shared utilities) |
| `src/guard/` | Request guard (auth check, rate limiting) |

### Key Abstractions

- **ExecutionStrategy** (`src/lib/execution-strategy.ts`) — Unifies request body prep, endpoint selection, response processing, and error handling across all route handlers.
- **TranslationPolicy** (`src/translator/anthropic/translation-policy.ts`) — Tracks exact vs lossy vs unsupported behavior explicitly; validation rejects unsupported fields with 400 instead of silently dropping them.
- **ModelResolver** (`src/lib/model-resolver.ts`) — Maps model IDs (e.g. `claude-sonnet-4.6` → actual Copilot model) with configurable fallbacks. Only applies to the chat completions strategy path; native Messages and Responses strategies pass model IDs through as-is.
- **Global State** (`src/lib/state.ts`) — Cached models list, VS Code version, request counters, config.
- **ModelTransformChain** (`src/transform/chain.ts`) — Composes rewrite, beta-header, and policy steps into a per-route transform chain. Eliminates inline model pipeline duplication across handlers.
- **ProtocolRegistry** (`src/ingest/registry.ts`) — Registry of protocol-specific parsers and context extractors. Each protocol registers a parse + extractMeta handler.
- **ConfigStore** (`src/state/config-store.ts`) — Typed config query interface replacing scattered `shouldUse*()` functions. Centralizes all feature flag queries.

## Code Conventions

- **Imports:** ESNext syntax only. Use `~/*` path alias for `src/*`. Prefer index exports (`~/clients`, `~/types`, `~/translator`). Use `import type` when possible.
- **Style:** `@antfu/eslint-config` flat config. Run `bun run lint --fix` to auto-fix.
- **Types:** Strict TypeScript. No `any`. No unused locals/parameters. No switch fallthrough. `verbatimModuleSyntax` enabled.
- **Naming:** `camelCase` for variables/functions, `PascalCase` for types/classes.
- **Errors:** Explicit error classes in `src/lib/error.ts` (`HTTPError`, `throwInvalidRequestError`). No silent failures.
- **Logging:** Use `consola` for human-readable output. For machine-readable output (e.g. `--json`), write clean data directly to stdout.
- **Testing:** Bun's built-in test runner (`bun:test`). Tests in `tests/*.test.ts`. Use `describe`/`test`/`expect` pattern.
- **CLI:** `start` must remain an explicit subcommand. No default command.
- **Complexity:** Favor direct implementation over unnecessary abstractions.
- **Runtime:** Bun is first-class. Prefer Bun-native APIs unless cross-runtime support is explicitly needed.

## Testing

- **Runner:** Bun built-in (`bun:test`). Place tests in `tests/`, name as `*.test.ts`.
- **Test helpers** (`tests/helpers.ts`):
  - Model builders: `buildModel()`, `buildGptModel()`, `buildVisionModel()`, `buildModelsResponse()`
  - Mock factories: `mockNonStreamingResponse()`, `mockStreamingResponse()`, `mockResponses()`, `mockMessages()`, `mockEmbeddings()`
  - State snapshot/restore: `saveStateSnapshot()` / `restoreStateSnapshot()` for test isolation
  - SSE stream utilities: `parseSse()`, `createStream()`
  - Default state setup: `setupDefaultTestState()`, `clearConfig()`
- Tests use typed fixture arrays for parameterized cases.
- `tests/api-smoke.test.ts` is the publish gate for public schema compatibility.

## Pre-commit Hooks

`simple-git-hooks` runs `lint-staged` which runs `bun run lint --fix` on all staged files.

## Branch & PR Workflow

- Feature branches with PRs; squash merge into `main`.

## Release Automation

- **Tag-triggered release pipeline:** `.github/workflows/release-npm.yml` handles changelog + npm publish.
- **Version contract:** The workflow validates that `vX.Y.Z` matches `package.json` `version` before publish.
- **Publishing auth model:** npm Trusted Publishing (GitHub OIDC). No long-lived npm tokens.
- **Typical release flow:** `bun run release:patch` (or `:minor` / `:major`) to bump, commit, and tag, then `git push && git push --tags`.
- **Version immutability:** npm does not allow republishing an existing version. Always bump before tagging.

## Design Documentation

`docs/design/` contains architecture and design documents. When making architectural changes, update the relevant docs to keep them in sync with the code.

Key references:
- `docs/solutions/` — documented solutions to past problems, organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.
- `docs/messages-routing-and-translation.md` — Routing logic for `/v1/messages`
- `docs/anthropic-translation-matrix.md` — Translation coverage between protocols
- `docs/design/model-routing.md` — Model pipeline design and context upgrade mechanics
- `docs/design/execution-strategy.md` — Strategy pattern and error handling
- `docs/design/translation-pipeline.md` — Full translation pipeline architecture

## Agent Instruction File Symlink (Windows-safe recipe)

`CLAUDE.md` is a git symlink (mode `120000`) pointing to `AGENTS.md`. Both names
are recognized by different agentic tools but always resolve to this single
source of truth.

### Golden rule

**Edit `AGENTS.md` only.** Never `Write`/`Edit` `CLAUDE.md` — on Windows that
replaces the symlink with a regular file and the two files drift again.

### Recreating the symlink (if it gets clobbered)

```bash
# 1. Write target path as file content (no trailing newline)
printf 'AGENTS.md' > CLAUDE.md

# 2. Create blob WITHOUT trailing newline and register as symlink (mode 120000)
git update-index --add --cacheinfo \
  120000,$(printf 'AGENTS.md' | git hash-object -w --stdin),CLAUDE.md

# 3. Checkout to materialize the OS-level symlink
git checkout -- CLAUDE.md

# 4. Verify
git ls-files -s CLAUDE.md   # must show mode 120000
```

Do NOT use `ln -s` (Git Bash on Windows silently makes a copy), `cp`, or `<<<`
here-strings with `git hash-object` (they append `\n` and break the target).

### After a fresh clone on Windows

```bash
git config --local core.symlinks true
git checkout -- CLAUDE.md
```

---

This file is tailored for agentic coding agents.
