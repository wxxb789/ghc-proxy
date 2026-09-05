# Upstream Request Queue

`UpstreamRequestQueue` centralizes Copilot admission, capacity cooldowns, bounded pre-`Response` recovery, and cleanup below all public protocol routes.

```text
Route -> strategy -> CopilotClient -> UpstreamRequestQueue -> Copilot
```

`src/clients/factory.ts` creates one queue per account runtime. `src/start.ts`
reads CLI/config values and calls `configureUpstreamRequestQueue()` directly;
the same queue settings apply to every account, but queue occupancy and cooldown
state do not cross account boundaries. Queue startup settings are not queried
through `ConfigStore`.

## Admission and Cooldown Scope

Each account queue holds its own active-slot count, pending list, account
deadline, and deadline map keyed by final effective upstream model.

| Upstream outcome | Cooldown scope | Effect |
|---|---|---|
| `429` | account | Blocks every new grant until the full deadline |
| `529` with effective model | model | Blocks only requests for that serialized model |
| `529` without effective model | request | Does not create shared cooldown state |
| other status/connection failure | none | No shared cooldown |

Capacity cooldown is installed before the triggering lease is released, including when retry count is zero or exhausted. Pending work stays FIFO among currently eligible requests: the drain skips cooled-model waiters and grants the oldest eligible waiter. If a global slot is free, cooled waiters occupying pending depth do not make an eligible request fail admission.

One coalesced timer tracks the earliest shared deadline inside an account queue.
A wake grants at most the number of free account-local slots. Active streams
still hold slots, and both active-slot capacity and maximum pending depth remain
shared across every model within the selected account. When all of that
account's slots are occupied and pending depth is full, an unrelated model on
the same account can still receive the existing queue-full `503`; this design
does not provide per-model reservations or quotas.

## Retry Policy

`UpstreamRequestContext.retryable` declares what one call site may replay:

| Request kind | Value | HTTP statuses |
|---|---|---|
| Generation (`/v1/messages`, `/chat/completions`, `/responses`) | `'capacity'` | `429`, `529` |
| Effect-free request | `true` | `408`, `429`, `500`, `502`, `503`, `504`, `529` |
| Non-replayable request | omitted | none |

Generation and effect-free requests may also retry the measured connection-establishment allowlist: Bun `ConnectionRefused`, or Node `ECONNREFUSED`, `ENOTFOUND`, and `EAI_AGAIN` found in the bounded cause chain. Caller aborts, all timeout shapes, TLS/configuration failures, resets, top-level generic fetch errors, body parsing, and stream failures are excluded.

The default is one retry after the original attempt; configuration accepts `0..2`. Capacity and approved connection failures share that counter. A configured overload fallback is a separate single dispatch and receives no new retry allowance, so the default maximum is original + one same-model retry + one fallback.

## Recovery Deadline and Pacing

The initial attempt keeps the normal `upstreamTimeoutSeconds`. At the first approved retryable outcome or the first encounter with an already-active cooldown, the queue creates one recovery record with a monotonic deadline. The budget defaults to 60 seconds and accepts `1..120`; it covers all later cooldown/backoff waits, queue acquisition, retry attempts until `fetch()` returns a `Response`, and overload fallback.

`Retry-After` parsing accepts a complete non-negative integer-seconds value, a complete fractional-seconds provider extension, or a strict HTTP-date. A valid value is a lower bound:

- the full server deadline is stored in account/model cooldown state;
- `upstreamQueueMaxDelaySeconds` never clamps it;
- if the wait does not fit the remaining request budget, same-model retry stops instead of firing early;
- the terminal source capacity result retains the source header, while a local cooldown result synthesizes rounded-up remaining seconds.

Without a valid header, full jitter is selected from `0` through:

```text
min(baseDelay * 2^retryCount, maxDelay, remainingRecoveryBudget)
```

`maxDelay` therefore caps computed backoff only. Every wait and queued acquisition observes caller cancellation and removes its timer/listener state.

## Response Commit Boundary

For any status the call site has not explicitly authorized the queue to handle privately, `fetch()` resolving to a `Response` commits the attempt. Before a retry, the private response body is cancelled and its lease is released. After a deliverable `Response` is returned, the lease remains active until body parsing or stream consumption finishes.

A `200` stream that fails before its first downstream event is still committed. JSON errors, body timeouts, and mid-stream disconnects do not enter retry or overload fallback. Caller cancellation and normal delivery timeout handling remain live after recovery listeners are disarmed.

For an overload fallback, the queue marks the target attempt authoritative
immediately before invoking its first `fetch()`. An internal recovery callback
commits the target model, strategy, and buffered effects at that boundary, so
active Dashboard state changes with the real dispatch rather than after the
target attempt settles.

## Defaults and Configuration

| CLI | `config.json` | Default | Bounds/meaning |
|---|---|---|---|
| `--upstream-queue-concurrency` | `upstreamQueueConcurrency` | `10` | positive integer active slots |
| `--upstream-queue-retries` | `upstreamQueueMaxRetries` | `1` | `0..2` retries |
| `--upstream-recovery-budget` | `upstreamRecoveryBudgetSeconds` | `60` | `1..120` seconds |
| `--upstream-queue-base-delay` | `upstreamQueueBaseDelaySeconds` | `2` | computed backoff base |
| `--upstream-queue-max-delay` | `upstreamQueueMaxDelaySeconds` | `60` | computed backoff cap only |

CLI values override the corresponding config fields for that process. Migrating from releases that defaulted to five retries requires no config change: absent `upstreamQueueMaxRetries` now means one. Values above two are rejected rather than silently preserving the old retry multiplier.

The concurrency CLI parser accepts only an integer greater than zero. Zero,
negative, fractional, blank, and non-numeric values log a warning and are
treated as absent; resolution then continues to a valid config value or the
default of 10. `config.json` applies the same positive-integer constraint and
omits an invalid field while preserving other individually valid fields. The
queue's programmatic constructor/update boundary additionally normalizes direct
numeric inputs to at least one active slot.

## Diagnostics and Public Errors

Recovery events retain the existing request ID, selected account name when
routing is enabled, and allowlisted structured fields for tests and injected
loggers. The default human console renders only compact one-line summaries,
omits zero-wait grants and duplicate cooldown/retry detail, and labels upstream
`429` as rate limited and `529` as overloaded. The model trace records a
successful substitution as `OVERLOAD_FALLBACK`.

Recovery-effect projection is currently a direct queue side effect:
`recordRecoveryEffect()` writes `recovery.queued`, `recovery.retry`,
`recovery.cooldown`, and qualifying `recovery.budget_exhausted` counters into
the process-global `runtimeStore.requests` before logging. Constructing a queue
with an injected logger does not isolate or replace that global write.

Logs do not serialize prompts, payloads, tools, authorization data, or tokens.
The operator-defined account name is included for request attribution when
hostname routing is enabled. Public errors keep their Anthropic/OpenAI-compatible
payload and safe standard `Retry-After`; the queue does not add retry-progress
SSE events, custom recovery headers, or a metrics endpoint.
