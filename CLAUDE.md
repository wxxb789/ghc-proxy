# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
bun run start                        # Production server (NODE_ENV=production)
bun run matrix:live                  # End-to-end Copilot upstream compatibility (uses real quota)
bun run smoke:packaged               # Smoke test the packaged CLI
bun run release:patch                # Bump patch, commit, tag (then git push manually)
```

**CI pipeline runs:** lint:all -> typecheck -> test -> build -> smoke:packaged

**Validation after non-trivial changes:** `bun run lint:all && bun run typecheck && bun run build && bun test`

## Architecture

### Request Flow

```text
Client Request -> Elysia Route Handler -> Zod Validation -> Execution Strategy Selection -> Adapter/Translator -> Copilot Client -> Response Translation -> Client
```

### Three Execution Paths for `/v1/messages`

The proxy uses a per-model strategy pattern (`src/routes/messages/strategies/`) to choose the best upstream path:

1. **Native Messages** — Direct `/v1/messages` passthrough when Copilot supports it
2. **Responses Translation** — Anthropic -> Responses -> Anthropic when only `/responses` is available
3. **Chat Completions Fallback** — Anthropic -> OpenAI Chat -> Anthropic (legacy)

See `docs/design/` for full architecture and design documentation, `docs/research/` for investigation notes, `docs/messages-routing-and-translation.md` for routing logic, and `docs/anthropic-translation-matrix.md` for translation coverage.

**Important:** When making architectural changes, update the relevant docs in `docs/design/` to keep them in sync with the code.

### Key Modules

| Directory | Purpose |
|-----------|---------|
| `src/routes/` | HTTP route handlers (each route is self-contained) |
| `src/translator/anthropic/` | Anthropic <-> OpenAI protocol translation with IR, normalization, and streaming transducers |
| `src/translator/responses/` | Anthropic <-> Responses format translation with signature codec |
| `src/adapters/` | Protocol adapters (OpenAI Chat, Anthropic Messages, Copilot transport) |
| `src/clients/` | GitHub, Copilot, and VS Code API clients |
| `src/core/capi/` | Copilot API compatibility layer (plan builder, profiles, request context) |
| `src/core/conversation/` | Conversation state management |
| `src/lib/` | Utilities (state, config, tokens, errors, model resolution, rate limiting, validation) |
| `src/types/` | TypeScript type definitions |

### Key Abstractions

- **ExecutionStrategy** (`src/lib/execution-strategy.ts`) — Unifies request body prep, endpoint selection, response processing, and error handling across all route handlers
- **TranslationPolicy** (`src/translator/anthropic/translation-policy.ts`) — Tracks exact vs lossy vs unsupported behavior explicitly; validation rejects unsupported fields with 400 instead of silently dropping them
- **ModelResolver** (`src/lib/model-resolver.ts`) — Maps model IDs (e.g. `claude-sonnet-4.6` -> actual Copilot model) with configurable fallbacks. Only applies to the chat completions strategy path; native Messages and Responses strategies pass model IDs through as-is
- **Global State** (`src/lib/state.ts`) — Cached models list, VS Code version, request counters, config

## Code Conventions

- **Imports:** ESNext syntax only. Use `~/*` path alias for `src/*`. Prefer index exports (`~/clients`, `~/types`, `~/translator`). Use `import type` when possible.
- **Style:** `@antfu/eslint-config` flat config. Run `bun run lint --fix` to auto-fix.
- **Types:** Strict TypeScript. No `any`. No unused locals/parameters. No switch fallthrough. `verbatimModuleSyntax` enabled.
- **Errors:** Explicit error classes in `src/lib/error.ts` (`HTTPError`, `throwInvalidRequestError`). No silent failures.
- **Logging:** Use `consola` for human-readable output. For machine-readable output (e.g. `--json`), write clean data directly to stdout.
- **Testing:** Bun's built-in test runner (`bun:test`). Tests in `tests/*.test.ts`. Use `describe`/`test`/`expect` pattern.
- **CLI:** `start` must remain an explicit subcommand. No default command.
- **Complexity:** Favor direct implementation over unnecessary abstractions.

## Pre-commit Hooks

`simple-git-hooks` runs `lint-staged` which runs `bun run lint --fix` on all staged files.

## Release Flow

1. `bun run release:patch` (or `:minor`/`:major`) — bumps version, commits, tags
2. `git push && git push --tags` — triggers `release-npm.yml` workflow
3. Workflow validates tag matches `package.json` version, runs full CI, publishes to npm via GitHub OIDC Trusted Publishing
