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

## Open Issues


### [medium] Emulator snapshot is not refreshed after array-replacing transforms

`prepareEmulatorRequest()` creates `effectiveInputItems` during `afterIngest` and uses the same array as `upstreamPayload.input`. Later transformations do not all affect that snapshot in the same way:

- `stripUnresolvableInputItems()` replaces `payload.input` with a filtered array. The prepared array is not replaced, so removed `item_reference` and orphaned `function_call_output` entries remain eligible for persistence.
- `stripPhaseFromInputMessages()` deletes `phase` from retained item objects in place. On the first attempt those objects are shared with the prepared array, so this mutation is reflected in the persisted snapshot; it is not the same stale-array bug.
- Other array-replacing transforms, including latest-compaction trimming, can likewise make the dispatched input differ from `effectiveInputItems`.
- The same `emulatorPrepared` record is reused when overload recovery prepares a fallback attempt. Re-running `afterTransform` on a clone does not refresh the persisted snapshot.

The result is that `GET /responses/:id/input_items`, continuation history, and token estimates based on that history can include entries the dispatched request no longer contained.

**Fix:** Refresh the emulator's effective input from the final transformed payload for the terminal attempt, or persist that attempt's post-policy input. Existing emulator tests cover create/retrieve, `input_items`, continuation, and `input_tokens`; add focused assertions that filtered/compacted items are absent from persisted state and that the fallback-attempt path records the final input.

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
