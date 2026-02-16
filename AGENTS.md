# AGENTS.md

## Build, Lint, and Test Commands

- **Build:**
  `bun run build` (uses tsdown)
- **Dev:**
  `bun run dev`
- **Lint:**
  `bun run lint` (uses @antfu/eslint-config)
- **Lint & Fix staged files:**
  `bunx lint-staged`
- **Test all:**
   `bun test`
- **Test single file:**
   `bun test tests/anthropic-request.test.ts`
- **Start (prod):**
  `bun run start`
- **Pack (dry-run):**
  `bun pm pack --dry-run`
- **Publish (manual):**
  `npm publish --access public` (with npm 2FA)
- **Release (auto bump + commit + tag):**
  `bun run release:patch` / `bun run release:minor` / `bun run release:major`

## Code Style Guidelines

- **Imports:**
  Use ESNext syntax. Prefer absolute imports via `~/*` for `src/*` (see `tsconfig.json`).
  Prefer index exports: `import { ... } from "~/clients"`, `import type { ... } from "~/types"`, `import { ... } from "~/translator"`.
- **Formatting:**
  Uses ESLint flat config via `@antfu/eslint-config` for linting and stylistic formatting. Run `bun run lint --fix` to auto-fix.
- **Types:**
  Strict TypeScript (`strict: true`). Avoid `any`; use explicit types and interfaces.
- **Naming:**
  Use `camelCase` for variables/functions, `PascalCase` for types/classes.
- **Error Handling:**
  Use explicit error classes (see `src/lib/error.ts`). Avoid silent failures.
- **Unused:**
  Unused imports/variables are errors (`noUnusedLocals`, `noUnusedParameters`).
- **Switches:**
  No fallthrough in switch statements.
- **Modules:**
  Use ESNext modules, no CommonJS.
- **Testing:**
   Use Bun's built-in test runner. Place tests in `tests/`, name as `*.test.ts`.
- **Paths:**
  Use path aliases (`~/*`) for imports from `src/`. Favor `~/clients`, `~/types`, and `~/translator` as public module entrypoints.

## Collaboration Preferences (Learned)

- **Runtime Priority:**
  Treat Bun as the first-class runtime. Prefer Bun-native APIs and Bun-oriented behavior unless cross-runtime support is explicitly requested.
- **Complexity Bar:**
  Favor senior-level simplicity. Avoid unnecessary wrappers/abstractions and choose the most direct implementation that remains robust.
- **CLI Output Contract:**
  Use `consola` for human-readable logs. For machine-readable output (for example `--json`), write clean data directly to stdout (Bun APIs preferred) without extra log prefixes.
- **Startup Error Handling:**
  Handle startup promise rejections explicitly and set a non-zero exit code for failures.
- **Validation Discipline:**
  After non-trivial changes, verify with `bun run lint:all`, `bun run typecheck`, `bun run build`, and `bun test` (when environment permissions allow).
- **CLI Command Surface:**
  Keep explicit subcommands. Do not introduce a default command; `start` must remain an explicit subcommand.

## Release Automation

- **Tag-triggered release pipeline:**
  `.github/workflows/release-npm.yml` is the single tag-triggered workflow and handles changelog + npm publish.
- **Version contract:**
  The workflow validates that `vX.Y.Z` matches `package.json` `version` before publish.
- **Publishing auth model:**
  Use npm Trusted Publishing (GitHub OIDC). Do not use long-lived npm tokens in repository secrets.
- **Typical release flow:**
  Run `bun run release:patch` (or `:minor` / `:major`) to bump, commit, and tag, then push branch and tag manually.
- **Version immutability:**
  npm does not allow republishing an existing version. Always bump to a new version before tagging.

---

This file is tailored for agentic coding agents. For more details, see the configs in `eslint.config.js` and `tsconfig.json`. No Cursor or Copilot rules detected.
