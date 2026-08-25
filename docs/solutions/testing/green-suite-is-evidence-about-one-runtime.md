---
title: "A green suite is evidence about the runtime you ran it on"
date: 2026-07-29
last_updated: 2026-08-25
category: testing
module: upstream timeout classification across Bun and Node
problem_type: convention
component: testing_framework
symptoms:
  - "A request the client experienced as a timeout comes back as a generic 500 carrying the runtime's raw error text"
  - "The suite is green, `grep` finds exactly one implementation of the rule, and the bug is live in production"
  - "The failure only reproduces under `node dist/main.mjs`, never under `bun test`"
root_cause: untested_runtime
resolution_type: code_fix
severity: high
applies_when:
  - "Writing or widening a predicate over an error, stream, or `fetch` shape in `src/`"
  - "Consolidating a rule into one implementation and calling the divergence risk closed"
  - "Reasoning about what the Node lane of CI actually executes"
  - "Reviewing a fix whose only evidence is a green `bun test`"
related_components:
  - "development_workflow"
  - "tooling"
tags:
  - "runtime-parity"
  - "bun-vs-node"
  - "fetch-error-shapes"
  - "ci-coverage"
  - "test-fixtures"
---

# A green suite is evidence about the runtime you ran it on

## Problem

`AGENTS.md` commits this repo to a two-runtime contract: "Route code under
`src/` must work on both Bun and Node." The test suite runs on one of them.
`.github/workflows/ci.yml` runs `bun test` under Bun; nothing in CI executes the
suite under Node.

That gap is invisible to every defence this repo already has. `docs/solutions/
conventions/duplicated-semantic-rules-diverge-silently.md` says to grep for every
implementation of a rule and collapse them into one. Do that, and grep returns
one hit, and the rule can still be wrong — because grep counts how many places
*implement* the rule, never how many *shapes* the one place has to accept. When
the two runtimes hand your predicate different inputs for the same event, a
single correct-looking implementation is correct on the runtime you tested and
blind on the other.

## Symptoms

- A production access-log line contradicts the code: `<- POST /v1/messages 500
  247s`, from a path that has an explicit 504 branch for exactly that condition.
- `grep` for the rule finds one implementation, called from every site. The
  single-source-of-truth checklist passes.
- The suite is green and stays green when you delete the branch that was
  supposed to handle the other runtime — because no fixture ever reaches it.

## What Didn't Work

**Consolidating the rule.** Before PR #69, "what counts as a timeout" had three
implementations: `src/server.ts` matched `error.name === 'AbortError'` only
(`git show 87f861b:src/server.ts`, line 57), the Anthropic stream transducer
matched `'TimeoutError'` only (`git show
87f861b:src/translator/anthropic/anthropic-stream-transducer.ts`, lines 335-343)
— two disjoint checks for one rule — and `tests/helpers.ts` held a hand-copy of
the server's `onError` handler (lines 206-220), so the test app could not
visibly diverge from the real one.

PR #69's first commit did the documented thing: one function,
`isTimeoutLikeError`, imported by both consumers. Its body was

```ts
return error.name === 'AbortError' || error.name === 'TimeoutError'
```

Both of those names are real on Node — a bare `controller.abort()` gives
`AbortError` and `AbortSignal.timeout()` gives `TimeoutError` on both runtimes,
because WHATWG pins them. What that body missed is the *other* Node source: when
undici's own connect/header/body ceiling fires, nothing named reaches the top
level at all. The consolidation was correct, the grep was clean, and the 500 was
still live. The second commit is where the actual fix landed. Both were squashed
into `09ef208`, so the pre-squash SHAs no longer exist on any checkout — read
the PR for the two-step sequence.

**Reading the Node lane of CI as coverage.** `AGENTS.md` used to claim
"Node-only regressions in `dist/main.mjs` are caught at publish time," with no
qualifier. At the time of PR #69, the gate behind that sentence was
`runSelfcheck('node', ...)` in `scripts/smoke/packaged-cli.ts`, and
`src/selfcheck.ts` contained only the five gpt-tokenizer encoding probes in
`PROBE_ENCODINGS`. It proved the bundle loaded and resolved under Node, but it
never constructed a `fetch`, an error, a stream, or a `Response`.

**Current state (2026-08-25).** Packaged smoke still runs `selfcheck` under both
Bun and Node, but `selfcheck` now contains 13 probes: five tokenizer probes and
eight entries in `RUNTIME_PROBES`. Those runtime probes cover the HTTP error
`Response` contract, connection-error classification, response-body
cancellation, response commit boundaries, caller cancellation, protocol
payloads, the Dashboard bundle, and the Node Dashboard listener boundary. This
materially widens the Node gate; it does not turn the Bun-native test suite into
a Node test suite or prove every route behavior under Node.

## Solution

**Get the shape from both runtimes before writing the predicate, and hand-roll
the other runtime's fixtures.**

The two shapes for a `fetch` timeout the *runtime itself* raises — not one we
abort — measured rather than reasoned about:

| Runtime | Rejection |
| --- | --- |
| Bun 1.3.14 | flat `DOMException`, `name: 'TimeoutError'`, `code: 23` (a **number**), no `.cause` |
| Node 24.18 | `TypeError('fetch failed')`, real error on `.cause`: `HeadersTimeoutError` / `UND_ERR_HEADERS_TIMEOUT` |
| Node, mid-stream | `TypeError('terminated')`, `.cause`: `BodyTimeoutError` / `UND_ERR_BODY_TIMEOUT` |

The Node top-level error carries no timeout signal at all, and
`TypeError('fetch failed')` is also what `ECONNREFUSED` and DNS failures wear.
So a `name` check is total on Bun and worthless on Node, which is why the
classifier at `src/lib/timeout-error.ts` walks `.cause` and matches on `code` as
well as `name`.

**Do not import the other runtime's library to build the fixture.** Verified
here:

```
// new errors.HeadersTimeoutError() from the bare `undici` specifier
bun 1.3.14 : { ctor: "HeadersTimeoutError", name: "Error",              code: undefined }
node 24.18 : { ctor: "HeadersTimeoutError", name: "HeadersTimeoutError", code: "UND_ERR_HEADERS_TIMEOUT" }
```

Bun resolves `undici` to its own shim. A fixture built from it carries neither
`name` nor `code`, so `isTimeoutLikeError` returns false for it and the
504-expecting test fails under `bun test` — against the *fixed* classifier.
The failure is loud, which is the good case; what it costs is the fixture's
meaning. It cannot distinguish a classifier that handles Node shapes from one
that does not, because it never carries a Node shape in the first place. The
plausible response to a red test is to weaken the assertion or drop the case,
and the Node branch ends up unpinned either way.
The timeout-classification fixtures in `tests/reliability.test.ts` hand-roll the
shapes instead, and say why in their doc comments.

## Why This Works

Grep answers "how many places implement this rule." Running the other runtime
answers "how many shapes does the one place have to accept." They are different
questions and only the second one has a runtime axis. This is the degenerate
case the sibling convention's sharpest line does not reach — "a green suite is
not evidence of consistency; it is evidence that each copy matches itself." With
exactly one copy, a green suite is evidence that the one copy matches the one
runtime the suite executes on.

The same measurement corrected a second belief that had already reached the
docs — the ~300s ceiling is an **idle** timer on both runtimes, not a
total-duration cap. `docs/design/streaming.md` carries that fact and the
per-runtime shape table; it is not repeated here.

**Your own failures being invisible in your own logs is what lets this
accumulate**, and this is the third time it has been the enabler. The shape is
the same each time: **an error path that returns early bypasses the
instrumentation the normal path carries.** Here `onError` returned a fresh
`Response` instead of falling through Elysia's normal path, so `set.status`
still held its pre-throw value when `onAfterResponse` read it — every error
logged as 500, including the ones the client received as 504 (the `onError` and
`onAfterResponse` hooks in `src/server.ts`). The same thread runs through
`duplicated-semantic-rules` ("local rejections were invisible in logs") and
`policy-rejection-is-not-a-protocol-limit` ("a local 400 produces no upstream
signal to investigate"). A wrong status in the access log is not cosmetic; it is
the removal of the one signal that would have shortened the search.

## When to Apply

Applies when a predicate, parser, or branch in `src/` reads a shape produced by
something on the other side of a boundary the repo does not control — a second
runtime, a second major of a library, a second upstream provider, a second OS.

It does **not** apply where a spec pins the shape. Measured on Bun 1.3.14 and
Node 24.18, a bare `controller.abort()` rejects as `DOMException` /
`AbortError` / code 20 on both, and `AbortSignal.timeout(n)` as `DOMException` /
`TimeoutError` / code 23 on both — byte-identical, because WHATWG specifies
both. `src/lib/upstream-signal.ts` aborts without a reason for exactly this
reason and needs no cross-runtime probe. The divergence is confined to shapes no
spec covers: undici's `headersTimeout` / `bodyTimeout`, Bun's undocumented
~300s ceiling, and the `.cause` chain each runtime builds under them.

**The test:** is the shape written down in a spec both implementations follow?
If yes, one runtime is evidence. If it is an implementation detail — an internal
timeout, a `.cause` chain, an aggregate's `code`, a `--json` envelope — probe
both.

## Prevention

- **Before writing a predicate over an error, stream, `crypto.subtle`, or
  `fetch` shape in `src/`, obtain one real instance from each runtime.** The
  shapes are not derivable from the spec, and neither runtime documents the
  other's. Write the probe so it runs unchanged on both and diff the output:

  ```bash
  bun  scripts/probe.mjs > /tmp/bun.json
  node scripts/probe.mjs > /tmp/node.json
  diff /tmp/bun.json /tmp/node.json   # non-empty = a shape your predicate must accept
  ```

  Include a spec-pinned case (a bare `controller.abort()`) alongside the case
  you care about. It agrees on both runtimes, which is what makes the
  disagreement in the other case legible rather than just "runtimes differ."
- **Hand-roll cross-runtime fixtures. Never import the other runtime's library
  under this one.** Bun's `undici` shim reports `name: 'Error'` and no `code`,
  so the fixture carries no Node shape at all — it fails against the correct
  classifier and proves nothing about the broken one. A fixture that cannot tell
  the two apart is not a regression test whichever way it goes.
- **A clean grep is not coverage evidence.** It bounds how many places implement
  the rule. It says nothing about the input space, and the runtime axis lives
  entirely in the input space.
- **Know what the Node lane actually runs.** As of 2026-08-25 it runs the five
  tokenizer probes and eight targeted runtime probes in `src/selfcheck.ts`, not
  the repository test suite. A current `rg -l "bun:test" tests -g "*.ts"`
  finds 27 test/helper modules tied to Bun's runner; the exact count will grow,
  but the architectural point is stable: closing the remaining gap is a
  test-runner migration or another deliberately scoped cross-runtime probe, not
  a CI flag. When a change's risk is Node-shaped and `selfcheck` does not exercise
  it, add a hand-rolled Node-shape fixture to the Bun suite or a focused runtime
  probe, as the risk warrants.
- **When a runtime-dependent belief reaches a doc comment, record the semantics,
  not the magnitude.** "~300s ceiling" is true and useless: idle-resetting and
  total-duration are opposite predictions for a proxy whose workload is long
  streams, and the number alone does not distinguish them. Cite what was
  measured and on which versions — the module comment in
  `src/lib/timeout-error.ts` names both runtimes' shapes and where the signal
  sits.

## Related

- `docs/solutions/conventions/duplicated-semantic-rules-diverge-silently.md` —
  the rule this one sits directly behind. Its diagnostic is a grep for multiple
  implementations, and here the grep was clean: `isTimeoutLikeError` in
  `src/lib/timeout-error.ts` has exactly one implementation, called from
  `src/server.ts` and
  `src/translator/anthropic/anthropic-stream-transducer.ts`. That doc's
  lesson is quoted almost verbatim in the module's own header comment. It was
  applied, the consolidation was correct, and the defect survived it. Its scope
  ends at implementation count; this one starts at input-space count.
- `docs/solutions/testing/regression-test-must-fail-first.md` — the other half of
  "the suite was green." There the missing evidence is that the test
  discriminates fixed from unfixed; here it is that the suite exercises the
  runtime the bug lives on. Both stash checks pass with this bug present.
- `docs/solutions/conventions/upstream-types-are-not-contract-evidence.md` — the
  same epistemics against an external system: only a probe tells you what
  upstream accepts. Here the second system is our own second runtime, and the
  probe is running the code on it.
- `docs/solutions/conventions/policy-rejection-is-not-a-protocol-limit.md` — its
  Context enumerates the modes by which a belief turns out wrong: never
  verified, implemented twice, attributed to the wrong layer. This is a fourth.
  The belief was verified, correctly attributed, and implemented exactly once —
  and tested against one of the two runtimes the code ships on.
- `docs/solutions/integration-issues/npm-pack-json-output-shape.md` — the same
  defect on a different axis ("never assume a CLI's `--json` output shape is
  stable across major versions"). Its failure was loud: npm 12's object shape
  crashed the parser on first contact. A wrong branch in a classifier is green
  until production.
- PR #69 (`09ef208`) — landed in two steps: a consolidation that was still
  Bun-only, then the Node shapes and their fixtures. `87f861b` is the base with
  three implementations; the two intermediate commits were squashed away.
