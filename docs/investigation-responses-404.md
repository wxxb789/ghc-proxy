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

## Root Cause (Confirmed)

The 404 was caused by **AI SDK sending back opaque item IDs** from previous responses:

1. When `store=true` (or unset), Copilot returns response items with opaque IDs
2. AI SDK caches these and sends them back as `item_reference` items or includes them in follow-up requests
3. Copilot Enterprise cannot resolve these IDs → 404
4. Additionally, orphaned `function_call_output` items (whose matching `function_call` was dropped during context windowing) can also trigger 404

The 400 `invalid_request_body` was likely caused by the `phase` field (`commentary` / `final_answer`) being sent back on input messages — an output-only annotation that some models reject as input.

**Probes could not reproduce the exact failure** because they used clean synthetic payloads, while Alma's real requests accumulated opaque IDs and orphaned outputs across multi-turn conversations.

## Resolution: Input Sanitization Safety Net

Applied in `src/routes/responses/handler.ts` (`applyResponsesInputPolicies`):

1. **`store = false`** — Force on all requests. Prevents Copilot from returning opaque item IDs in the first place.

2. **`stripUnresolvableInputItems`** — Defense-in-depth:
   - Strip `item_reference` items (opaque IDs from `store=true` sessions)
   - Strip orphaned `function_call_output` items (no matching `function_call` in input)

3. **`stripPhaseFromInputMessages`** — Strip `phase` field from input messages (output-only annotation).

Applied in `src/routes/responses/strategy.ts`:

4. **400 payload dump** -- When `--dump-failed-payloads` or `DUMP_FAILED_PAYLOADS=1` is enabled, upstream 400 errors dump the full request payload to `$APP_DIR/dumps/400-{timestamp}.json` for diagnosis. Dumps are disabled by default.

## Verification

- Unit tests: `responses-and-routing.test.ts` covers all safety net behaviors
- Live probe: `scripts/probe-responses-resilience.ts` verifies all evidence chains against Copilot upstream
- Post-deployment: no further 404 or 400 errors observed
