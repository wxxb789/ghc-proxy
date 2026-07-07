# TODO

Tracked items for future work. Items are roughly ordered by priority.

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

- [ ] **Add `"sideEffects": false` to `package.json`**
  - Enables tree-shaking optimizations in bundler
  - Codebase appears side-effect-free at module scope

### Medium Priority

- [ ] **Expand test coverage for under-tested modules**
  - Clients (`CopilotClient`, `GitHubClient`, `VSCodeClient`) — only mocked, never directly tested
  - Rate limiting (`src/state/rate-limiter.ts`) — no dedicated tests
  - Request guard middleware (`src/routes/middleware/request-guard.ts`) — tested indirectly through routes only
  - Request logger (`src/lib/request-logger.ts`) — no isolated tests
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

- [ ] **Reduce emulator branching duplication**
  - `src/routes/responses/resource-handler.ts` has repeated `if (shouldUseResponsesOfficialEmulator())` checks
  - Could consolidate with strategy pattern or early return

## Research

- [ ] **Evaluate `ai-tokenizer` as a replacement for `gpt-tokenizer`**
  - Project: https://github.com/coder/ai-tokenizer
  - Current tokenizer: `gpt-tokenizer` (v3.4.0) — used in `src/lib/tokenizer.ts` for local token estimation in `count_tokens` endpoint and chat completions usage
  - Current usage: lazy-loaded encoders (`o200k_base`, `cl100k_base`, `p50k_base`, `p50k_edit`, `r50k_base`) cached per encoding type, with model-specific constants for tool/message token calculation
  - Questions to answer:
    - Does `ai-tokenizer` support the same encoding types?
    - How does bundle size compare? (`gpt-tokenizer` contributes to the single-file `dist/main.mjs`)
    - Performance: encoding speed, memory footprint
    - Does it support Bun natively?
    - Does it handle Claude/Anthropic tokenization or is it OpenAI-only like `gpt-tokenizer`?
    - Accuracy: does it produce the same token counts for the same inputs?

- [ ] **Evaluate a discriminated `AnthropicDocumentSource` union for `AnthropicDocumentBlock.source`**
  - Surfaced by a simplify-pass review; anchored at `src/translator/anthropic/types.ts` (`AnthropicDocumentBlock`)
  - Current: `source: Record<string, unknown>`; `formatDocumentBlock`, `describeDocumentBlock`, and `createDocumentContent` each narrow it at the point of use
  - **UNVERIFIED — the finding may be wrong. Verify / evaluate / design before acting:**
    - Confirm the exact set of Anthropic-supported document source variants and their fields against the current Messages API spec (`text | base64 | url | content | file` differ per type). A precise union that omits a real variant would 400 otherwise-valid requests.
    - Check whether the loose `Record<string, unknown>` is deliberate forward-compat passthrough; the point-of-use narrowing may already make the leak acceptable.
    - Weigh the type-design blast radius (this type feeds multiple translation paths) against the parse-don't-validate benefit before committing.
