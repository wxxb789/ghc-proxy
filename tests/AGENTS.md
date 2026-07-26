# tests/AGENTS.md

> **Convention**: `tests/CLAUDE.md` is a symlink to this file (git mode
> `120000`). Edit this file only; never `Write`/`Edit` `tests/CLAUDE.md`.
> Recreation recipe lives at the bottom of the root `AGENTS.md`.

Test-runner conventions and helper inventory for the `tests/` directory.
For project-wide rules see the root `AGENTS.md`.

## Runner

Bun's built-in test runner (`bun:test`). Place new tests in this directory
as `*.test.ts` and use the `describe` / `test` / `expect` pattern.

```bash
bun test                          # All tests
bun test tests/validation.test.ts # Single file
bun test tests/contract-smoke.test.ts # Publish gate for public schema compatibility
```

`tests/contract-smoke.test.ts` is the **publish gate** for public schema
compatibility — if it fails, the package must not ship.

## Helper inventory (`tests/helpers.ts`)

| Group | Exports |
|-------|---------|
| Model builders | `buildModel()`, `buildGptModel()`, `buildVisionModel()`, `buildModelsResponse()`, `buildResponsesResult()` |
| App factory | `createApp()` — assembles an in-process Elysia app over the real route handlers |
| Mock factories | `mockNonStreamingResponse()`, `mockStreamingResponse()`, `mockResponses()`, `mockMessages()`, `mockEmbeddings()`, `mockChatCompletions()`, `mockGetResponse()`, `mockGetResponseInputItems()`, `mockCreateResponseInputTokens()`, `mockDeleteResponse()`, `mockEmulatorCreateResponses()` |
| SSE utilities | `parseSse()` |
| State isolation | `saveStateSnapshot()`, `restoreStateSnapshot()`, `setupDefaultTestState()`, `clearConfig()` |
| Assertions | `expectCacheCheckpoints()` |

## Conventions

- **Use typed fixture arrays for parameterized cases** (`test.each` or a
  loop over a typed array of `{ name, input, expected }`). One `test` block
  per case keeps failures localized.
- **Wrap state-mutating tests in snapshot/restore.** Call
  `saveStateSnapshot()` in `beforeEach` and `restoreStateSnapshot()` in
  `afterEach` so cross-test pollution doesn't appear as flaky behavior.
  `setupDefaultTestState()` covers the common default config.
- **Don't mock what you can use real.** Prefer `createApp()` over hand-rolled
  Elysia wiring; prefer the SSE parsing helpers over inline string splits.
- **Intercepting upstream calls.** There are two seams, and which one you use
  depends on what you're testing:
  - *Transport concerns* (headers, retries, base URL, error mapping) —
    construct a client directly with an injected fetch:
    `new CopilotClient(auth, config, { fetch })`. See
    `upstream-transport.test.ts` and `clients-auth.test.ts`.
  - *Routing and translation* — assign to `CopilotClient.prototype.*` and
    restore it in `afterEach`, which is how the route tests reach a client
    built deep inside the request path.

  The handlers that bypass `runPipeline` (`handleEmbeddingsCore`,
  `handleModelsCore`, and the `/responses/{id}` resource handlers) also take
  an optional `client`, so a new test can inject one instead of patching the
  prototype. Prefer that when calling those handlers directly.
- **Bun-native APIs are fine here.** Unlike `src/`, the test runtime is
  always Bun.
- **No fixture files larger than ~5KB inline.** Move large captured payloads
  to `tests/fixtures/` and import them.

## When to add a test

- Every new route gets at least one test covering the happy path.
- Every translation policy change (`exact` ↔ `lossy` ↔ `unsupported`) gets
  a test asserting the new behavior, including the 400 path when
  `unsupported`.
- Every new strategy gets a test verifying it's reachable through the
  `StrategyRegistry`.
- Bug fixes get a regression test that fails before the fix.
