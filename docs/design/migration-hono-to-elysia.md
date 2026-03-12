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
| WU-8 | Framework Switch | in progress | |
| Verify | Full CI pipeline | pending | |

## Phase 1: Extract Framework-Agnostic Logic

All WUs extract `*Core` functions returning plain data. Existing Hono wrappers stay intact.

### WU-1: SSE Execution Strategy Decoupling
- File: `src/lib/execution-strategy.ts`
- Add `ExecutionResult` discriminated union type
- Add `runStrategy()` that returns `ExecutionResult` instead of `Response`
- Keep `executeStrategy()` as thin Hono wrapper

### WU-2: Error Handling Decoupling
- File: `src/lib/error.ts`
- Add `createErrorResponse(error): Promise<Response>` using `Response.json()` directly
- Keep `forwardError(c, error)` as thin Hono wrapper

### WU-3: Request Logger Decoupling
- File: `src/lib/request-logger.ts`
- Extract `logRequest(method, url, status, elapsed, modelInfo?)` pure function
- Keep `requestLogger` middleware and `setModelMappingInfo` as wrappers

### WU-4: Request Guard Decoupling
- File: `src/routes/middleware/request-guard.ts`
- Extract `runRequestGuard(): Promise<void>` pure function
- Keep `requestGuard` middleware as wrapper

### WU-5: Simple Route Handlers
- `src/routes/models/route.ts` → `handleModelsCore(): Promise<object>`
- `src/routes/embeddings/route.ts` → `handleEmbeddingsCore(body): Promise<object>`
- `src/routes/token/route.ts` → `handleTokenCore(): object`
- `src/routes/usage/route.ts` → `handleUsageCore(): Promise<object>`

### WU-6: Streaming Handler Decoupling (depends on WU-1)
- `src/routes/chat-completions/handler.ts` → `handleCompletionCore()`
- `src/routes/messages/handler.ts` → `handleMessagesCore()`
- `src/routes/messages/count-tokens-handler.ts` → `handleCountTokensCore()`
- `src/routes/responses/handler.ts` → `handleResponsesCore()`

### WU-7: Resource Handler Decoupling
- `src/routes/responses/resource-handler.ts` → 4x `*Core()` functions

## Phase 2: Framework Switch

### WU-8: Install Elysia, Rewrite Server/Routes/Tests, Remove Hono
- Replace hono with elysia + @elysiajs/cors in package.json
- Rewrite src/server.ts to Elysia
- Rewrite all route files to Elysia plugins
- Update src/start.ts (server.fetch → server.handle)
- Delete src/types/hono.d.ts
- Remove all Hono wrappers
- Migrate 5 test files

## Verification

```bash
bun install
bun run lint:all && bun run typecheck && bun run build && bun test
bun run smoke:packaged
```
