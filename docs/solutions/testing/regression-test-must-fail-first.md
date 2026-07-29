---
title: "A regression test that never failed is not a regression test"
date: 2026-07-25
last_updated: 2026-07-29
category: testing
module: tests
problem_type: convention
component: testing_framework
symptoms:
  - "New regression test passes on the first run, before the fix is even applied"
  - "Test asserts on a signal the buggy code already produced for an unrelated reason"
  - "Suite is green but the bug can silently return"
root_cause: weak_assertion
resolution_type: test_fix
severity: medium
applies_when:
  - "Writing a regression test for a bug fix"
  - "Reviewing a PR that adds tests alongside a fix"
  - "Asserting on shared state (timers, counters, logs) rather than the specific behavior"
tags:
  - "regression-test"
  - "tautological-test"
  - "git-stash"
  - "test-verification"
  - "mutation-testing"
---

# A regression test that never failed is not a regression test

## Problem

`tests/AGENTS.md` requires that "bug fixes get a regression test that fails
before the fix." The rule is easy to satisfy on paper and easy to violate in
practice: a test can pass against the buggy code for a reason that has nothing
to do with the bug, and it will look identical to a real regression test — same
name, same green checkmark, same line in the diff.

The failure mode is silent by construction. A tautological test never goes red,
so nothing ever draws attention to it. It costs review time forever and catches
nothing.

## Symptoms

- The new test passes on its very first run, before the fix is applied.
- The assertion reads on shared or aggregate state — a timer list, a call
  counter, a log buffer — that other code paths in the same test also write to.
- Deleting the fix leaves the suite green.

## What Didn't Work

**Trusting the test because it was written after reading the bug.** During
PR #50, two `UpstreamRequestQueue` cooldown bugs were fixed:

1. The cooldown was installed *after* `lease.release()`, so a waiter was
   granted the freed slot before back-pressure existed.
2. The non-retry path only applied a cooldown when `!context.retryable`, missing
   budget exhaustion and `maxRetries: 0`.

Three regression tests were written, each asserting
`timers.some(timer => timer.delay > 0)` — "a drain timer is armed, therefore the
cooldown was applied." That reasoning is correct in isolation and wrong in
context: on the retry path an *earlier* iteration had already armed a timer, so
`timers` was non-empty regardless of whether the final release applied a
cooldown. Two of the three tests asserted a condition the buggy code already
satisfied.

They looked like regression tests. They were assertions about the harness.

## Solution

Verify the test fails against the unfixed code, mechanically, before trusting
it. Stash the source change (not the test) and run:

```bash
git stash push src/clients/upstream-queue.ts
bun test tests/upstream-queue-retry.test.ts   # every new test must FAIL here
git stash pop
bun test tests/upstream-queue-retry.test.ts   # and PASS here
```

In PR #50 this printed `21 pass, 1 fail` — exposing that two of the three new
tests were tautological. Rewriting them to assert the *specific* behavior, not a
shared side effect, produced `19 pass, 3 fail` against the old code and
`22 pass, 0 fail` against the new.

The rewrites replaced "some timer exists" with an assertion no other code path
could satisfy:

```ts
// Tautological — an earlier retry iteration already armed a timer,
// so this holds against the buggy code too.
expect(timers.some(timer => timer.delay > 0)).toBe(true)

// Ordering: park the dispatch mid-backoff and observe the queued waiter
// directly. Only correct ordering can keep it from reaching fetcher().
await new Promise(resolve => setTimeout(resolve, 10))
expect(waiterCalls).toBe(0)

// Budget exhaustion: compare timer count across the release, so an
// earlier iteration's timer cannot satisfy the assertion.
const armedBeforeRelease = timers.length
queued.release()
expect(timers.length).toBeGreaterThan(armedBeforeRelease)
```

## Why This Works

The stash run supplies the one piece of evidence a green test cannot: proof that
the assertion discriminates between the fixed and unfixed code. Without it,
"test passes" is consistent with both "the fix works" and "the test is blind."

Asserting on a **delta** (`timers.length` before vs. after) or on a **specific
observable** (did this waiter call `fetcher()`?) rather than an aggregate
predicate (`timers.some(...)`) is what makes the discrimination possible. An
aggregate over shared state is satisfiable by any writer to that state; a delta
across the exact operation under test is not.

## Prevention

- **Run the stash check for every bug-fix regression test.** `git stash push
  <source files>` → test → `git stash pop`. If it does not go red, the test is
  not testing the fix. This is the executable form of the `tests/AGENTS.md`
  rule.
  - *Necessary but not sufficient — it is per-fix, not per-branch.* Stashing
    removes every new branch at once, so one covered branch turns the suite red
    and masks all its uncovered siblings. In PR #69 (`09ef208`) the stash check
    passed, and deleting any single one of the fix's new branches individually —
    the `.errors` walk, the `ETIMEDOUT` code, the whole `TIMEOUT_ERROR_CODES`
    set, or lowering `MAX_CAUSE_DEPTH` to 1 — still left the suite green. When a
    fix adds more than one branch, delete each one on its own and re-run.
  - *Watch for fixtures that carry redundant signals.* The classifier checks
    `name` before `code` (`src/lib/timeout-error.ts:60-63`) and both Node
    fixtures set **both**, so the `name` check short-circuited and the `code`
    branch never ran. A fixture exercises only the first signal the
    implementation reads; over-specifying it hides every branch behind that one.
  - *Pair surviving mutants with a negative control.* Replacing the whole
    predicate with `=> false` must fail loudly. Without that control, "the mutant
    survived" is ambiguous between an untested branch and a harness that never
    ran the test at all.
- **Distrust assertions over accumulated state.** Timer lists, call counters,
  log buffers, and emitted-event arrays are written by many code paths. Prefer a
  delta measured across the operation, or an observable only the fixed behavior
  can produce.
- **A count of failures is the signal, not just "some test failed."** Three new
  tests must produce three failures. `21 pass, 1 fail` where three were expected
  is the tell — check the per-test names, not just the exit code.
- **Ordering bugs need a witness, not a state check.** When the bug is *when*
  something happens rather than *whether*, freeze the system mid-operation (an
  injected `sleep` that never resolves works well) and assert on what a
  concurrent actor observed at that instant.

## Related

- `tests/AGENTS.md` — "Bug fixes get a regression test that fails before the
  fix." This doc is how to verify that rule was actually met.
- `docs/solutions/testing/green-suite-is-evidence-about-one-runtime.md` — the
  other reason a green suite proves less than it looks. This doc's check asks
  whether the test discriminates fixed from unfixed code; that one asks whether
  the suite runs on the runtime the bug lives on. The stash check passes in both
  failure modes.
- `docs/design/upstream-request-queue.md` — the cooldown semantics the PR #50
  tests cover.
- PR #50 (`feb86d4`) — the fixes and the rewritten tests.
- PR #69 (`09ef208`) — where the stash check passed and five of the fix's six
  branches were still unverified.
