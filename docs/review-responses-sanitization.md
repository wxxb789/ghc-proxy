# Review: /responses Input Sanitization (2026-04-09; refreshed 2026-08-25)

Adversarial review of commits `74e24bb` (input sanitization safety net) and `1397d5d` (cleanup refactor).

## Context

These commits added input sanitization to `/v1/responses` to prevent 404/400 errors caused by opaque item IDs and orphaned outputs from AI SDK clients. The implementation has since moved across the route lifecycle: item filtering remains in `src/routes/responses/handler.ts`, while reusable `phase` removal lives in `src/transform/responses-input.ts`. See [investigation-responses-404.md](investigation-responses-404.md) for the historical root cause analysis.

## Accepted Policy

### Silent `store=false` coercion keeps the upstream path stateless

`applyResponsesInputPolicies()` unconditionally forces the upstream payload to `store = false`. When the official emulator is disabled (the default), clients sending `store: true` get a successful create but cannot rely on retrieve/delete/continuation state later. When the emulator is enabled, `prepareEmulatorRequest()` captures the original store intent and implements those resource semantics locally, so the issue is limited to the non-emulated path.

The August 25, 2026 direct upstream probe selected option 3 from the original
review: keep the coercion as an intentional proxy-wide policy and document it.
Both `gpt-5.6-sol` and `gpt-5.4` rejected `store: true`; omission and
`store: false` created responses, but returned IDs could not be retrieved,
listed, referenced, or continued. The optional emulator implements local state
semantics when they are required.

**Files:** `src/routes/responses/handler.ts` (`afterIngest`, `applyResponsesInputPolicies`), `src/routes/responses/emulator.ts` (`prepareEmulatorRequest`)

## Completed (review remediation, 2026-08-25)

### Emulator persistence uses the terminal attempt's transformed input

`prepareEmulatorRequest()` creates the expanded upstream payload during
`afterIngest`, but the input that is eligible for persistence is captured later.
Each pipeline attempt clones `payload.input` in `buildStrategyContext()`, after
all array-replacing and in-place transforms have run:

- filtered `item_reference` and orphaned `function_call_output` entries are not
  persisted;
- in-place `phase` removal is reflected in the stored input;
- latest-compaction trimming is reflected in the stored input; and
- overload recovery captures a separate final-input snapshot for the fallback
  attempt, so the terminal target attempt is authoritative.

`GET /responses/:id/input_items`, continuation history, and token estimates now
derive from the same final input that the successful attempt dispatched.
Focused regressions cover filtered input, compacted input, and fallback-attempt
persistence for streaming and non-streaming responses.

**Files:** `src/routes/responses/handler.ts` (`afterIngest`, `afterTransform`, `buildStrategyContext`), `src/routes/responses/emulator.ts` (`prepareEmulatorRequest`, `persistEmulatorResponse`), `src/pipeline/runner.ts` (fallback attempt preparation)

## Completed (issue #20 fix)

- Failed `/responses` payload dumps are disabled by default and require `--dump-failed-payloads` / `-D` or `DUMP_FAILED_PAYLOADS=1`.
- Dump directory and dump files request restrictive permissions where supported.

## Completed (refactor commit 1397d5d)

- Dump directory uses `PATHS.APP_DIR` instead of hardcoded `~/.ghc-proxy`
- Readability: extracted variables in strip functions
- Deduplicated timestamp in `dumpFailedPayload`
- Moved regexes to module scope per lint rules
- Removed redundant inline comments
