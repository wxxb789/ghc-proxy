# TODO

Tracked items for future work. Items are roughly ordered by priority.

## Known Defects

- [ ] **`reasoning.effort: none` leaks to models that reject it (`/responses`)**
  - `clampResponsesReasoningEffort` (`src/transform/parameter-filter.ts`) returns early for `none` and `minimal`, on the belief — probed 2026-07-26 — that every `/responses` model advertises `none`.
  - `grok-4.5` does not. Verified through the proxy 2026-08-04: `{"model":"grok-4.5","reasoning":{"effort":"none"}}` → `400 This model does not support 'reasoning_effort' value 'none'`. The same request with `effort: max` returns 200 (clamps to `high`), so only the unranked bypass leaks.
  - Not a plain clamp-up: `none` means "do not reason", and the nearest advertised level (`low`) is a materially different request. Options are to drop the field, to reject locally with a clear message, or to map to `low` and say so — pick deliberately rather than by default.
  - Evidence: `docs/research/grok-4.5-schema.md`. Convention amended in `docs/solutions/conventions/upstream-types-are-not-contract-evidence.md`.

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
