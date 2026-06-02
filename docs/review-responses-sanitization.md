# Review: /responses Input Sanitization (2026-04-09)

Adversarial review of commits `74e24bb` (input sanitization safety net) and `1397d5d` (cleanup refactor).

## Context

These commits add input sanitization to `/v1/responses` to prevent 404/400 errors caused by opaque item IDs and orphaned outputs from AI SDK clients. See [investigation-responses-404.md](investigation-responses-404.md) for the full root cause analysis.

## Open Issues

### [high] Silent `store=false` coercion breaks stateful Responses contract

`applyResponsesInputPolicies()` unconditionally forces `payload.store = false`. When the official emulator is disabled (the default), clients sending `store: true` get a successful create but broken retrieve/delete/continuation semantics — the failure is deferred to later requests.

**Options:**
1. Reject `store: true` with 4xx when emulator is off (explicit contract)
2. Implement local state emulation for those requests
3. Accept the current silent coercion as intentional (document the limitation)

**Files:** `src/routes/responses/handler.ts:217-225`


### [medium] Emulator persists pre-sanitized history

`prepareEmulatorRequest()` snapshots `effectiveInputItems` before the handler strips `item_reference`, orphaned `function_call_output`, and `phase`. `persistEmulatorResponse()` later stores that original snapshot. This means:
- `GET /responses/:id/input_items` returns items the proxy refused to send upstream
- Local `input_tokens` count diverges from the actual request
- Invalid items get reintroduced into emulator state on continuation

**Fix:** Sanitize `effectiveInputItems` before persisting, or persist the post-policy `effectivePayload.input` instead. Add regression tests for `input_items`/`input_tokens` after stripping.

**Files:** `src/routes/responses/emulator.ts:72-121`, `src/routes/responses/handler.ts:43-53`

## Completed (issue #20 fix)

- Failed `/responses` payload dumps are disabled by default and require `--dump-failed-payloads` / `-D` or `DUMP_FAILED_PAYLOADS=1`.
- Dump directory and dump files request restrictive permissions where supported.

## Completed (refactor commit 1397d5d)

- Dump directory uses `PATHS.APP_DIR` instead of hardcoded `~/.ghc-proxy`
- Readability: extracted variables in strip functions
- Deduplicated timestamp in `dumpFailedPayload`
- Moved regexes to module scope per lint rules
- Removed redundant inline comments
