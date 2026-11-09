# TODO

Tracked items for future work. Items are roughly ordered by priority.

## Known Defects

- [ ] **`reasoning.effort: none` leaks to models that reject it (`/responses`)**
  - `clampResponsesReasoningEffort` (`src/transform/parameter-filter.ts`) returns early for `none` and `minimal`, on the belief — probed 2026-07-26 — that every `/responses` model advertises `none`.
  - `grok-4.5` does not. Verified through the proxy 2026-08-04: `{"model":"grok-4.5","reasoning":{"effort":"none"}}` → `400 This model does not support 'reasoning_effort' value 'none'`. The same request with `effort: max` returns 200 (clamps to `high`), so only the unranked bypass leaks.
  - Not a plain clamp-up: `none` means "do not reason", and the nearest advertised level (`low`) is a materially different request. Options are to drop the field, to reject locally with a clear message, or to map to `low` and say so — pick deliberately rather than by default.
  - Evidence: `docs/research/grok-4.5-schema.md`. Convention amended in `docs/solutions/conventions/upstream-types-are-not-contract-evidence.md`.

- [ ] **Upstream request queues of removed or replaced route targets are never released**
  - `src/clients/factory.ts` keys queues by runtime in a `WeakMap` (`accountQueues`) but also adds every queue to a strong module-level `Set` (`upstreamRequestQueues`), kept only so `configureUpstreamRequestQueue()` can broadcast option changes. The `Set` defeats the `WeakMap`: a runtime removed or replaced by an account mutation (for example `configureM365Target` with a changed runtime) keeps its queue alive for the process lifetime.
  - Reproduced 2026-11-08 with a scratch test during the architecture review. Impact is bounded: one queue per admin mutation, and the only production `configureUpstreamRequestQueue()` call (`src/start.ts`) runs at startup before any queue exists.
  - Local fix candidates: build each queue from the current options and track queues weakly, or release a runtime's queue when the account mutation disposes the runtime.

- [ ] **Dashboard reports Messages structured output for models that reject `output_config`**
  - `canServeMessagesOutputFormat()` (`src/routes/messages/strategy-registry.ts`) asks the Messages strategy decision, but `canUseNativeMessages` does not check `modelCache.supportsOutputConfig()`. For `MODELS_REJECTING_OUTPUT_CONFIG` models (`claude-sonnet-4.5`, `claude-haiku-4.5`) that advertise `/v1/messages` and `structured_outputs`, `sanitizeOutputConfig` (`src/transform/sanitize.ts`) deletes the whole `output_config`, format included, yet the Dashboard shows structured output as available. Pre-existing; found during the 2026-11-09 architecture-review fixes. Fixing it changes Messages routing, so decide the intended route first.

- [ ] **Device auth accepts the reserved account name `m365`**
  - `AccountManager.startAccountAuthentication` does not reject `m365`; only `writeNewGitHubCredential` (`src/lib/credentials.ts`) refuses it at persist time. With a persistence double that writes no credential, a GitHub runtime ends up under the M365 kind. Validation gap, found 2026-11-09.

## Upstream Probe Refresh

- [ ] **Re-probe `/responses` + `/chat/completions` (gpt/gemini) upstream surface**
  - The 2026-07-25 refresh covered only the Claude `/v1/messages` surface (models, output_config/effort, cache threshold, official tools). The `/responses` and gpt/gemini rows in `docs/design/model-routing.md` "Model Endpoint Map" are still the 2026-06-17 baseline and may be stale.
  - These models now have partial, topic-specific probe coverage, but not one comprehensive surface refresh: `gpt-5.6-terra` / `-sol` / `-luna` (prompt caching, sampling, web search), `gemini-3.6-flash` (Gemini capability probes), and `mai-code-1-flash-picker` (web-search acceptance). `trajectory-compaction` still lacks a usable baseline.
  - Re-run sequentially (shared rate-limited upstream, burns real quota): `scripts/probes/responses-resilience.ts`, `scripts/probes/tool-support.ts` (responses models), `scripts/matrix/live-compat-matrix.ts` as needed.
  - Confirm June-17 `/responses` findings still hold: `store:true` → 400 (ZDR org), `previous_response_id` → 400, encrypted_content round-trip, gemini-3.1-pro-preview cache-miss.
  - Update the endpoint map + `docs/messages-routing-and-translation.md` and refresh the `project-copilot-upstream-status` memory snapshot.

## Best Practices Improvements

### High Priority

- [ ] **Add Dependabot or Renovate for automated dependency updates**
  - No `.github/dependabot.yml` or renovate config exists
  - Security patches currently require manual tracking
  - Recommendation: add Dependabot with weekly schedule for npm ecosystem

- [ ] **Add test coverage reporting**
  - Configure `--coverage` in test script and CI pipeline
  - Set coverage thresholds (e.g., 80%) as CI gate
  - Gives visibility into which modules lack tests

### Medium Priority

- [ ] **Expand test coverage for under-tested modules**
  - VS Code version discovery (`src/clients/vscode-client.ts`) — local command and package-file fallbacks are only mocked by consumers
  - Rate limiting (`src/state/rate-limiter.ts`) — no dedicated tests
  - Request guard middleware (`src/routes/middleware/request-guard.ts`) — tested indirectly through routes only
  - Concurrent request / race condition scenarios

- [ ] **Reduce route registration duplication in `src/server.ts`**
  - Root-level and `/v1`-prefixed routes registered separately with identical call lists
  - Could extract shared route array to avoid drift

- [ ] **Refine `lint-staged` rules**
  - Current config: `"*": "bun run lint --fix"` runs linter on all file types
  - Could scope to `"*.ts"` for faster staged-file processing

### Low Priority

- [ ] **Handle bare `catch` blocks in error parsing**
  - `src/lib/error.ts` `throwUpstreamError()` silently swallows JSON parse failures
  - Consider logging parse failures at debug level

## Research

- [ ] **Remove `gpt-tokenizer` after a compatible counting replacement is proven**
  - First milestone complete: Chat Completions no longer tokenizes requests for diagnostic logging, and `gpt-tokenizer` is a dev dependency rather than a separately installed runtime dependency.
  - Current retained usage: `src/lib/tokenizer.ts` supplies Anthropic `count_tokens`, Responses official-emulator `input_tokens`, and packaged selfcheck probes.
  - The published bundle still includes lazy-loaded `o200k_base`, `cl100k_base`, `p50k_base`, `p50k_edit`, and `r50k_base` encodings, plus model-specific constants for tool/message token calculation.
  - The September 6, 2026 raw capability gate failed: the default account returned `404` for `gpt-5.5` `/responses/input_tokens`, and `claude-sonnet-5` was absent from its model inventory. Retain the local estimators until every required model and count surface has a verified replacement.

- [ ] **Evaluate a discriminated `AnthropicDocumentSource` union for `AnthropicDocumentBlock.source`**
  - Surfaced by a simplify-pass review; anchored at `src/translator/anthropic/types.ts` (`AnthropicDocumentBlock`)
  - Current: `source: Record<string, unknown>`; `formatDocumentBlock`, `describeDocumentBlock`, and `createDocumentContent` each narrow it at the point of use
  - **UNVERIFIED — the finding may be wrong. Verify / evaluate / design before acting:**
    - Confirm the exact set of Anthropic-supported document source variants and their fields against the current Messages API spec (`text | base64 | url | content | file` differ per type). A precise union that omits a real variant would 400 otherwise-valid requests.
    - Check whether the loose `Record<string, unknown>` is deliberate forward-compat passthrough; the point-of-use narrowing may already make the leak acceptable.
    - Weigh the type-design blast radius (this type feeds multiple translation paths) against the parse-don't-validate benefit before committing.

## Dead-Code Candidates

Recorded during other work; revalidate before removing.

- [ ] **`POST /dashboard/api/m365/remove` has no client**
  - Handler: `src/routes/dashboard/route.ts` (`.post('/dashboard/api/m365/remove', …)`), calling `AccountManager.removeM365Target()`.
  - Neither the pre-Svelte Dashboard (`src/routes/dashboard/assets.ts` at `e4551e7`) nor the Svelte UI in `ui/` calls it; the Svelte UI removes the M365 target through `DELETE /dashboard/api/accounts/m365`. No test or doc references the route.
  - `removeM365Target()` itself stays in use (`src/accounts/manager.ts`, account removal path). Removal would only drop the route and must keep the Dashboard API contract tests green.

- [ ] **`RequestMeta.sessionId` is written but never read**
  - Written by `src/ingest/anthropic-messages.ts`, `src/ingest/openai-chat.ts`, and `src/ingest/responses.ts`; declared in `src/ingest/types.ts`. No reader in `src/`, `tests/`, `scripts/`, or `ui/` (verified 2026-11-08). The same value stays available as `requestContext.clientSessionId`.

- [ ] **`IngestedRequest.protocol` is written but never read**
  - Written at `src/ingest/registry.ts` (`protocol: id`); the only caller of `ProtocolRegistry.ingest()` (`src/pipeline/runner.ts`) reads `meta` and `payload` and branches on `config.protocol`. `ProtocolId` itself stays in use.

- [ ] **`RESPONSES_INPUT_POLICY` negated guards are unreachable**
  - Both flags in `src/transform/responses-input.ts` are `as const` `true`, so the `!RESPONSES_INPUT_POLICY.filtersUnresolvableItems` and `!RESPONSES_INPUT_POLICY.rejectsRemoteImageUrls` early returns in `src/routes/responses/handler.ts` never fire. The flags are still read for display by the Dashboard behavior contract (`src/routes/dashboard/handler.ts`, `contract.ts`, `ui/src/views/behavior/rows.ts`), so removal must keep or redesign that projection; only the negated halves of the guards are dead.

- [ ] **Identity `upstream → kind` ternaries in the Dashboard**
  - `upstream === 'm365' ? 'm365' : 'github'` in `src/routes/dashboard/handler.ts` (`upstreamOf`) and `src/routes/dashboard/m365.ts` returns its input, because `AuthStore.upstream` is already the `TargetKind` union (`src/state/auth.ts`, `src/lib/account-routing.ts`). Read `runtime.auth.upstream` directly.

- [ ] **Over-exported symbols reported by `knip`**
  - `M365_ANTHROPIC_VERSION` and `M365_API_VERSION` (`src/clients/m365-upstream.ts`) are used only in their own file; the `ConfigStore` and `RuntimeStore` class exports are unused outside their singletons. Dropping `export` is enough.

- [ ] **`runWithAccountRuntime` wrappers around `initializeM365Target` are redundant**
  - Since `acquireM365Credential()` writes to the runtime it is given and the client receives its runtime explicitly, `initializeM365Target(runtime)` no longer reads the ambient request runtime (`fetchM365Models` takes the token and endpoint as arguments). The wrappers in `AccountManager.registerM365Target` / `configureM365Target` warm-up (`src/accounts/manager.ts`) and in the M365 startup path (`src/start.ts`) can likely be dropped; revalidate that nothing else under them reads `getCurrentAccountRuntime()` first.

- [ ] **`TargetRuntimeOptions.mscAuthExe` / `mscAuthUpn` have no production caller**
  - Since `createTargetRuntime` falls back to `auth` fields and defaults the UPN from config (`src/accounts/target-runtime.ts`), no `src/` caller passes these two options; only `tests/m365-endpoints.test.ts`, `tests/msc-auth.test.ts`, and `tests/target-runtime.test.ts` do. Dropping them means passing the values through `auth` in those tests.
