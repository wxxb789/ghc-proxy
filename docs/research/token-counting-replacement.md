# Token Counting Replacement Evidence

## Verdict

**G1a did not pass. Do not enable upstream-only counting or delete the local tokenizer.**

On September 6, 2026, a bounded raw Copilot screen for the default account found
`gpt-5.5` advertised, but its `/responses/input_tokens` operation returned HTTP
404. The other authorized model, `claude-sonnet-5`, was absent from the account's
37-model inventory. No other model or account was substituted.

This is evidence for the tested account/model/path, not a universal statement
about every Copilot deployment. It is sufficient to block this plan's full
removal milestone. U5 and U6 were not implemented; G1b remains pending. The
independent Chat diagnostic and duplicate-installation optimizations proceed.

## Scope and Request Ledger

The operator explicitly authorized the default account, these two models, at
most 10 HTTP requests including authentication and inventory, synthetic
text/tools, no generation, and stopping subsequent cases after a path's 404.

The existing default account used a legacy config credential. It was read in
memory through an injected credential reader; no credential migration, file
write, account reconfiguration, or running-service restart was performed.
Requests went directly to the session-discovered Copilot API, not through the
local proxy's counting handlers. Secrets, headers, and raw response bodies are
not retained here.

| Cumulative request | Operation | Result |
| --- | --- | --- |
| 1 | GitHub Copilot session acquisition | 200 |
| 2 | Raw model inventory | 200; initial screen stopped at model membership validation |
| 3 | Session acquisition for the diagnostic continuation | 200 |
| 4 | Raw model inventory | 200; 37 models; selected model results below |
| 5 | `gpt-5.5` raw `/responses/input_tokens`, synthetic text | 404, 162 ms |

Total: **5 HTTP requests, 1 count request, 0 generation requests**. The first
screen discarded its in-memory session on exit, so the continuation acquired a
new one. A cumulative transport guard enforced the original 10-request budget.
There were no automatic transport retries or further requests after the 404.
The remaining five requests were not spent.

Completion timestamp: `2026-09-06T15:29:43.449Z` (September 6 in Asia/Shanghai).
Probe headers used VS Code `1.104.3` and the repository's existing Copilot header
builder. No claim is made that these are the latest upstream client versions.

## Capability Matrix

| Account | Model | Advertised generation operations | Count operation | Content | Result |
| --- | --- | --- | --- | --- | --- |
| default | `gpt-5.5` | `/responses`, `ws:/responses` | `/responses/input_tokens` | One synthetic user text message | 404; remaining text/tool/negative cases stopped |
| default | `claude-sonnet-5` | Not advertised | `/v1/messages/count_tokens` | None sent | Untested: selected model absent |

The `gpt-5.5` inventory metadata reported `capabilities.tokenizer: o200k_base`.
That metadata does not establish a counting operation. No count value, healthy
latency distribution, multimodal support, or usage-comparison accuracy was
measured by this screen.

## Unmet Gates

- Other accounts, native Messages models, Chat-only models, and the complete
  supported model matrix have not been tested under this authorization.
- Valid image/PDF, history, reasoning/compaction, positive input-response and
  negative validation controls remain untested after the failed initial screen.
- Actual Claude Code workflows and direct SDK callers against controlled
  success/error/timeout/cancellation responses remain unverified. Embedded
  client strings are not workflow evidence.
- No operator acceptance of an upstream-only network dependency is implied by
  permission to perform this probe.
- G1b payload parity, account/queue ownership, Node cancellation and deadline
  behavior, and candidate p95 latency remain pending because no replacement
  candidate was enabled.

These gaps are recorded, not waived. Further capability work requires a new
bounded authorization if it involves additional accounts/models or live calls.

## Reusable Offline-First Probe

`scripts/probes/token-counting.ts` defaults to dry-run: it does not read
credentials or make network requests without `--live`. Account, models, request
budget, and VS Code version are explicit. Its production credential reader uses
the named credential store without migration; this run supplied a read-only
legacy reader through the testable function interface.

```powershell
bun scripts/probes/token-counting.ts --account default --account-type enterprise --vscode-version 1.104.3 --messages-models claude-sonnet-5 --responses-models gpt-5.5 --max-requests 10
```

The same command with `--live` is **not** part of normal verification or CI and
requires scoped authorization. The script reports missing models instead of
silently choosing another one, rejects an insufficient declared budget before
credential access, has a 10-second per-operation deadline including JSON body
consumption, forbids redirects, stops same-model/path cases after 404, and stops
the screen on 401/403/429. Its result never declares G1a passed: this small
screen cannot establish the complete gate.

`tests/token-counting-probe.test.ts` exercises dry-run isolation, budget
enforcement, endpoint restrictions, missing-model behavior, 404 stop rules,
authentication/capacity stops, malformed counts, and secret-free reports using
only an injected fake transport.

## Preserved Product Behavior

- `/v1/messages/count_tokens` retains its existing local estimator.
- Default Responses input-token counting retains upstream passthrough at both
  existing aliases, including its existing error behavior.
- Responses emulator input-token counting retains its local estimator and
  explicit-model requirement.
- Generation usage remains sourced from upstream responses.
- Five bundled encodings and their Bun/Node selfchecks remain available.

See `tokenizer-cost-baseline.md` for measured first-milestone changes and
`../plans/2026-09-06-2254-perf-tokenizer-cost-removal-plan.md` for the conditional
implementation contract. This execution record does not turn incomplete
full-removal requirements into completed work.
