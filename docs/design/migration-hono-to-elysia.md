# Migration Plan: Hono → Elysia

## Status Tracking

| WU | Description | Status | Notes |
|----|-------------|--------|-------|
| WU-1 | SSE Execution Strategy Decoupling | ✅ done | Added `ExecutionResult`, `runStrategy()` |
| WU-2 | Error Handling Decoupling | ✅ done | Added `createErrorResponse()` |
| WU-3 | Request Logger Decoupling | ✅ done | Added `logRequest()`, `computeElapsed()` |
| WU-4 | Request Guard Decoupling | ✅ done | Added `runRequestGuard()` |
| WU-5 | Simple Route Handlers | ✅ done | 4 Core functions extracted |
| WU-6 | Streaming Handler Decoupling | ✅ done | 4 Core functions extracted |
| WU-7 | Resource Handler Decoupling | ✅ done | 4 Core functions extracted |
| WU-8 | Framework Switch | ✅ done | Elysia installed, all routes/tests migrated, Hono removed |
| Verify | Full CI pipeline | ✅ done | lint, typecheck, 105 tests, build, smoke all pass |

## Migration Complete

All phases completed successfully. The project now uses Elysia as its HTTP framework.

### Summary of Changes

**Phase 1 (Framework-Agnostic Extraction):**
- Extracted `*Core` functions from all route handlers
- Added `runStrategy()` returning `ExecutionResult` discriminated union
- Added `createErrorResponse()` for framework-agnostic error handling
- Added `logRequest()` and `computeElapsed()` pure logging functions
- Added `runRequestGuard()` pure guard function

**Phase 2 (Framework Switch):**
- Replaced `hono` with `elysia` + `@elysiajs/cors` in package.json
- Rewrote `src/server.ts` to use Elysia with `derive()`, `onAfterHandle`, `onError`
- Rewrote all 7 route files as Elysia plugins
- Created `src/lib/sse-adapter.ts` to bridge `AsyncGenerator<SSEOutput>` to Elysia SSE
- Updated `src/start.ts` (`server.fetch` → `server.handle`)
- Deleted `src/types/hono.d.ts`
- Removed all Hono wrappers from handler files
- Migrated 5 test files from `Hono` + `app.request()` to `Elysia` + `app.handle(new Request(...))`
- Updated `scripts/live-compat-matrix.ts` (`server.request` → `server.handle`)

### Verification Results

```bash
bun run lint:all      # ✅ clean
bun run typecheck     # ✅ clean
bun test              # ✅ 105 tests pass
bun run build         # ✅ dist/main.mjs produced
bun run smoke:packaged # ✅ packaged CLI smoke test passes
```
