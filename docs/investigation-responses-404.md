# Investigation: Responses API 404/400 on Copilot Enterprise

## Timeline

1. Alma client using `gpt-5.4` via ghc-proxy → Copilot Enterprise `/responses` intermittently gets `404 { error: { message: '', code: 'not_found' } }`
2. Small requests succeed; large requests (218 items, 87 function_call pairs, 15 reasoning items) fail
3. Added debug summary logging and retry logic (3 attempts, 1s/2s backoff) to ghc-proxy
4. Later: `400 invalid_request_body` errors also observed with gpt-5.4

## Probe Results

### Round 1 — Top-level fields
`store`, `reasoning`, `include`, payload size alone → **not the cause**

### Round 2 — Input item types
- Synthetic `item_reference` with fake ID → 404 (expected: ID doesn't exist)
- Synthetic `encrypted_content` with fake blob → 400 (expected: can't decrypt garbage)
- These pointed at `item_reference` and `encrypted_content` as suspects

### Round 3 — Real encrypted_content round-trip
- Obtained real `encrypted_content` from Copilot, sent it back → **6/6 PASS**
- Copilot can round-trip its own `encrypted_content` perfectly
- **Conclusion: `encrypted_content` is NOT the root cause**

### Round 4 — Scale testing
| Test | Items | Result |
|------|-------|--------|
| 1 reasoning item | 4 | PASS |
| 5 reasoning items | 16 | PASS |
| 5 reasoning + 10 fc pairs | 36 | PASS |
| 5 reasoning + 30 fc pairs | 76 | PASS |
| 5 reasoning + 50 fc pairs | 116 | PASS |
| 5 reasoning + 87 fc pairs | 190 | PASS |
| Same without encrypted_content | 190 | PASS |
| 30s stale encrypted_content | 4 | PASS |

**All pass.** Item count, reasoning count, function_call count, encrypted_content staleness — none reproduce the 404.

### EC Diagnostic — encrypted_content consistency
- `effort=low` → no reasoning item returned (model skips reasoning)
- `effort=medium/high` → reasoning + `encrypted_content` consistently returned
- 5/5 consistency check → all returned `encrypted_content`

## Historical Root Cause (Confirmed for the 2026-04 Incident)

The 404 was caused by **AI SDK sending back opaque item IDs** from previous responses:

1. A successful create with `store` omitted returns response items with opaque IDs
2. AI SDK caches these and sends them back as `item_reference` items or includes them in follow-up requests
3. Copilot Enterprise cannot resolve these IDs → 404
4. Additionally, orphaned `function_call_output` items (whose matching `function_call` was dropped during context windowing) can also trigger 404

The 400 `invalid_request_body` was likely caused by the `phase` field (`commentary` / `final_answer`) being sent back on input messages — an output-only annotation that some models reject as input.

**Probes could not reproduce the exact failure** because they used clean synthetic payloads, while Alma's real requests accumulated opaque IDs and orphaned outputs across multi-turn conversations.

## Resolution: Input Sanitization Safety Net

Applied in `src/routes/responses/handler.ts` (`applyResponsesInputPolicies`):

1. **`store = false`** — Force the explicitly supported stateless mode. Current
   GPT Responses models reject `store=true`; successful stateless responses can
   still contain IDs, but those IDs are not retrievable or continuable.

2. **`stripUnresolvableInputItems`** — Defense-in-depth:
   - Strip `item_reference` items because Copilot cannot resolve returned item
     IDs on a later request
   - Strip orphaned `function_call_output` items (no matching `function_call` in input)

3. **`stripPhaseFromInputMessages`** — Strip `phase` from input messages (output-only annotation). The reusable implementation now lives in `src/transform/responses-input.ts` and is also used by the Messages-to-Responses strategy.

When the optional official Responses emulator is enabled, it keeps the caller's original `store` intent for local retrieve/delete/continuation semantics while still sending `store=false` upstream. Without the emulator, resource semantics are not supplied locally.

Applied in `src/routes/responses/strategy.ts`:

4. **400 payload dump** -- When `--dump-failed-payloads` or `DUMP_FAILED_PAYLOADS=1` is enabled, upstream 400 errors dump the full request payload to `$APP_DIR/dumps/400-{timestamp}.json` for diagnosis. Dumps are disabled by default.

## Verification Scope

### Raw upstream revalidation (2026-08-25)

The canonical result is recorded in [Responses Upstream Notes](responses-upstream-notes.md#storefalse). It confirms that the raw Enterprise Responses endpoint was stateless for `gpt-5.6-sol` and `gpt-5.4` on this date and supports the proxy-wide `store=false` policy plus `item_reference` filtering. Stateful retrieve/delete/continuation behavior, when enabled, is supplied by the local emulator rather than by this upstream endpoint.

### Historical incident evidence

The following statements describe the evidence gathered for the April 2026 incident, not a perpetual upstream guarantee:

- The live probe in `scripts/probes/responses-resilience.ts` exercised the evidence chains against the then-current Copilot upstream.
- Post-deployment observation at that time found no further instances of the investigated 404/400 signatures.

Current automated coverage is split by responsibility:

- `tests/responses-routing.test.ts` directly covers forcing `store=false`, filtering `item_reference`, filtering orphaned `function_call_output`, combined filtering, and stripping `phase` before dispatch.
- `tests/responses-emulator.test.ts` covers emulator create/retrieve, `input_items`, streaming and non-streaming persistence, continuation, delete/TTL behavior, pagination, and `input_tokens` estimation.

Those emulator tests establish the resource lifecycle, but they do not by themselves prove that every array-replacing input transform is reflected in the persisted `effectiveInputItems` snapshot; that remaining distinction is tracked in [review-responses-sanitization.md](review-responses-sanitization.md).
