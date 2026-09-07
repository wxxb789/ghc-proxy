# Tokenizer Cost Reduction: Execution Evidence

## Scope

This record covers the independent first milestone of
`../plans/2026-09-06-2254-perf-tokenizer-cost-removal-plan.md`: remove diagnostic
tokenization from Chat Completions generation and avoid installing a duplicate
tokenizer dependency. It is **not full tokenizer removal**.

The raw capability gate failed; see `token-counting-replacement.md`. Local
Messages/emulator estimators, five bundled encodings, count-only CAPI payloads,
and tokenizer selfchecks remain intact. No heuristic or new provider was added.

## Controlled Baseline

- Baseline source: `466f4d7b467c5f21ed2ad1206cfe713a0d87d93f`.
- Candidate: uncommitted first-milestone changes on
  `codex/tokenizer-cost-reduction`, based on that same commit.
- Date: September 6, 2026.
- Runtime: Bun `1.4.0`; packaged Node validation pinned to `24.19.0`.
- Host: Windows `10.0.26200`, x64; AMD EPYC 7763, 16 logical processors exposed,
  68,665,831,424 bytes of RAM. This is not a controlled production load test.
- Baseline source was extracted with `git archive`; its dependency directory
  referenced the same installed versions as the candidate. Baseline and
  candidate dist outputs were built separately with the pinned Bun toolchain.
- Performance workers use local in-process upstream mocks and synthetic
  payloads. The running service on port 4141 is not part of the benchmark.
- Package checks use isolated temporary installs and the existing offline npm
  cache; no public npm registry switch or live generation test was used.

## Call-Site Inventory

| Consumer | Baseline | First-milestone candidate |
| --- | --- | --- |
| Direct Chat Completions generation | Awaited `getTokenCount()` before dispatch for logging, including fallback preparation | Diagnostic import and await deleted |
| Messages count endpoint | Local `getTokenCount()` plus applicable calibration/built-in-tool estimation | Unchanged |
| Responses emulator count endpoint | Local `estimateSerializedTokens()` | Unchanged |
| Default Responses count endpoint | Upstream passthrough, not a local estimator | Unchanged |
| Packaged `selfcheck` | Exercises five encoding families | Unchanged |
| Generation response usage | Upstream counters | Unchanged |

The retained source imports are in `src/selfcheck.ts`,
`src/routes/messages/count-tokens-handler.ts`, and
`src/routes/responses/emulator.ts`. The dependency remains bundled; moving it
to devDependencies does not eliminate vocabulary chunks or local counting CPU.

## Characterization

Before the production edit, the new isolated real-handler test failed as
intended: **1 encoding module load and 4 encode calls** across four mocked
upstream calls. Those calls cover a tool request with the model's output-token
default, a streaming request with an explicit token limit, and a source/target
overload fallback pair.

After deleting the diagnostic block, the same test passed with **0 encoding
loads and 0 encode calls**. It also checks upstream usage passthrough in
non-streaming, streaming, and fallback responses. The existing contract,
parameter-filter, pipeline, Messages-routing and emulator suites cover retained
payload/default/rename behavior.

The test bundles the actual handler graph with a Bun build plugin that replaces
encoding imports with a counting sentinel, then runs it in a fresh subprocess.
Throwing from the sentinel alone is insufficient because the old diagnostic
block swallowed errors; the assertions explicitly check load/call counters.

## Build Size

Fresh build sizes, in bytes:

| Artifact | Baseline | Candidate | Reduction |
| --- | ---: | ---: | ---: |
| Published JavaScript files | 7,348,592 | 7,348,261 | 331 |
| Tokenizer encoding/runtime chunks | 4,790,673 | 4,790,673 | 0 |
| Source maps | 12,284,585 | 12,283,933 | 652 |
| Complete dist directory | 19,633,177 | 19,632,194 | 983 |

Baseline `dist/main.mjs` SHA-256:
`1efe6a8c7f9fbb94ea16421f1c8cc341cf8b43193224824abff92b0fab5d4eb6`.
Candidate `dist/main.mjs` SHA-256:
`7638d4efcfe99f53ca626542d81eac1ca9cc67a0f89755ba435db1c15e9629c9`.

Source maps are not included by the npm `files` allowlist. A Docker image layer
was not measured in this run; logical dist size is not compressed layer size.
The full-removal bundle thresholds are not met and are not claimed.

## Package and Installation Size

Paired `npm pack --ignore-scripts --json` and isolated
`npm install --ignore-scripts --offline --no-audit --no-fund --no-package-lock`
measurements used the same npm cache and freshly built artifacts:

| Measurement (bytes) | Baseline | Candidate | Reduction |
| --- | ---: | ---: | ---: |
| Actual compressed npm tarball | 2,482,018 | 2,482,734 | -716 |
| Unpacked published package | 7,395,888 | 7,397,036 | -1,148 |
| Entire installed node_modules logical bytes | 72,559,941 | 19,457,239 | 53,102,702 |
| Separately installed gpt-tokenizer directory | 53,103,516 | 0 | 53,103,516 |

All other installed package names and versions matched between the two
installs. The approximately **50.64 MiB** tokenizer-directory saving is measured
logical file size, not allocated disk space, download bytes, or a guaranteed
saving for every package manager. The 814-byte difference between total and
tokenizer-only savings includes the packaged third-party notice and installer
metadata changes.
Other dependencies named `@tokenizer/*` remain unrelated transitive packages;
they are not this BPE implementation and were not removed.

Tarball SHA-256 values:

- Baseline: `f01f61c72c8953e83ebca4588e84bba109d85980a31a21ffce19471f42356fe6`.
- Candidate: `993217a36ecfa854e1869d4d2d81729c9360076fd0c5d329ef5c5a2c3141e194`.

The candidate tarball is 716 bytes larger because it now carries the bundled
tokenizer's MIT notice. That small package increase is separate from the
53,102,702-byte consumer-install reduction. Consumer install checks and runtime
smoke are also separate: the former quantify dependency files; the latter
execute the complete published import graph.

## Runtime Measurements

The same `scripts/benchmarks/tokenizer-cost.ts` ran serially against both roots.
Its SHA-256 for both runs was
`b05b649f5ab912782385237928f1444f062b0448431d3f5b50551663dc9cf03f`.
Baseline completed at `2026-09-06T15:45:25.173Z`; candidate completed at
`2026-09-06T15:49:24.189Z`.

Ordinary cases used 10 fresh-process cold samples, 30 warmed samples with the
BPE merge cache cleared between operations, and 30 repeated-input warm-cache
samples per layer. The candidate Chat path has no BPE cache to clear. Cold
measurements include source import/setup, not just pre-dispatch execution;
warm measurements exclude setup. Handler and tokenizer-helper measurements are
separate. GC runs before and after measured operations. Median averages the two
middle values for even sample counts; p95 uses nearest rank.

The six ordinary corpus sizes (serialized UTF-8 bytes) were English 153, CJK
157, TypeScript 198, JSON 174, twelve tools 2,748, and a valid one-pixel PNG 284.
The script materializes only the selected case, and helper measurements do not
initialize the application handler/model cache. No concurrent benchmark or
test/build command was run during each measurement process. Normal host
activity was not frozen.

### Direct Chat Results

All values below are wall milliseconds, **median / p95**, baseline -> candidate:

| Corpus | Cold process | Warm, merge cache cleared | Warm, repeated input |
| --- | --- | --- | --- |
| English | 548.05 / 622.16 -> 173.46 / 270.14 | 1.094 / 2.695 -> 0.766 / 1.455 | 1.093 / 3.572 -> 0.672 / 0.978 |
| CJK | 513.39 / 569.91 -> 193.63 / 329.92 | 0.993 / 1.545 -> 0.890 / 3.135 | 0.770 / 1.268 -> 1.127 / 3.498 |
| TypeScript | 581.67 / 1237.65 -> 331.58 / 610.74 | 0.775 / 1.322 -> 1.640 / 2.960 | 0.787 / 1.503 -> 0.738 / 4.638 |
| JSON | 472.92 / 530.09 -> 167.59 / 202.57 | 0.822 / 1.501 -> 0.627 / 0.915 | 0.859 / 1.391 -> 0.641 / 1.527 |
| Tools | 551.10 / 635.60 -> 137.37 / 171.09 | 1.603 / 2.371 -> 0.892 / 1.439 | 1.442 / 2.120 -> 1.158 / 3.329 |
| PNG | 527.61 / 590.80 -> 161.95 / 272.53 | 1.215 / 1.767 -> 0.851 / 1.325 | 1.129 / 2.380 -> 0.854 / 1.800 |

No ordinary Chat median regressed by both more than 5% and more than 2 ms.
Some sub-millisecond differences and p95 values worsened; this is not evidence
that every warmed request becomes faster. The unchanged helper also showed
substantial cold-run variation (English median 466.24 -> 751.37 ms), so cold
wall-time differences must not be treated as a precise production speedup.
Warm ordinary CPU medians rounded to zero at this host's process CPU-counter
resolution; zero is not a claim of zero CPU work.

### Bounded Repeated Input

Each bounded case/mode used one sample and a **20-second subprocess deadline**.
For warmed modes, that deadline includes the warmup operation. A censored
warmed worker therefore does not prove its measured operation alone exceeded
20 seconds. Non-timeout process failures are errors, not censored samples.

| Chat corpus / mode | Baseline wall | Candidate wall | Baseline CPU | Candidate CPU |
| --- | ---: | ---: | ---: | ---: |
| 100k repeated characters, cold | 12,242.48 ms | 192.42 ms | 12,375 ms | 375 ms |
| 100k, warm cache cleared | Censored | 1.184 ms | Unavailable | Below counter resolution |
| 100k, repeated warm input | 7.105 ms | 1.163 ms | Below counter resolution | Below counter resolution |
| 1M repeated characters, cold | Censored | 109.03 ms | Unavailable | 219 ms |
| 1M, warm cache cleared | Censored | 1.020 ms | Unavailable | Below counter resolution |
| 1M, repeated warm input | Censored | 1.322 ms | Unavailable | Below counter resolution |

The completed 100k cold pair shows **96.97% less combined process CPU** across
import, setup, and handler execution. Because that interval includes work
outside request dispatch, it does not establish the plan's request-only 90%
pre-dispatch CPU target. That numeric target remains unproven. The separate
regression test is the direct evidence that pre-dispatch BPE loads/calls are
zero.

The retained helper still performed costly work: its 100k cold sample took
10,860.85 ms baseline and 16,635.02 ms candidate. Its 1M workers were censored in
all three modes for both roots. No helper improvement is claimed, and these
results do not establish an implementation regression in unchanged code.

### Memory and Limits

For the English cold Chat samples, median RSS growth through post-operation GC
was 107,421,696 -> 31,043,584 bytes. Median total post-GC RSS was
136,663,040 -> 59,260,928 bytes; peak process `maxRSS` across those samples was
177,820 -> 59,268 KiB. These are separate measurements, not quantities to add.
RSS includes allocator/JIT/runtime effects and is not a heap-retention proof.
If a real process later invokes a retained local count endpoint, it can still
load and retain the vocabulary; no universal process-memory saving is promised.

These measurements do not cover real Copilot generation latency or HTTP QPS.
Actual client counting workflows and Docker layer measurements remain outside
the completed evidence, as recorded in the replacement report.

### Unchanged Generation Controls

A separate serial in-process control completed at
`2026-09-06T15:52:16.119Z` under Bun 1.4.0. Each root/route used 10 fresh-process
samples including imports/setup, plus 30 warm samples after one warmup. It
reused `tests/helpers.ts` state/model/result builders, invoked the real
`handleMessagesCore` or `handleResponsesCore`, and replaced only the matching
`CopilotClient` generation method. Native Messages used an advertised
`/v1/messages` model and `max_tokens: 32`; Responses used an advertised
`/responses` model. Both inputs were `Compare throughput and latency.` Every
sample asserted a JSON result and the expected one upstream mock call (31
including warmup for a warm worker). No listening service or live upstream was
used.

| Route / mode | Baseline median / p95 (ms) | Candidate median / p95 (ms) |
| --- | ---: | ---: |
| Native Messages, cold | 300.23 / 574.58 | 290.01 / 400.55 |
| Native Messages, warm | 0.297 / 1.921 | 0.251 / 0.688 |
| Responses, cold | 436.57 / 534.03 | 390.03 / 551.28 |
| Responses, warm | 0.244 / 0.915 | 0.279 / 1.030 |

Neither control median regressed by both more than 5% and more than 2 ms. The
Responses warm difference was 0.035 ms; its percentage alone is misleading.
These representative controls do not replace the broader route/translation
contract tests or establish production percentiles.

To reproduce after extracting the baseline source and installing the same
locked development dependencies, run serially with the same pinned runtime:

```powershell
bun scripts/benchmarks/tokenizer-cost.ts --root=<baseline-source-root> --pathological
bun scripts/benchmarks/tokenizer-cost.ts --root=<candidate-source-root> --pathological
```

Each JSON result includes raw samples, runtime, source identity, harness hash,
cache mode, payload size, CPU, wall time, timer delay, RSS, and censored outcomes.
An archived baseline has no `.git`, so its source commit is identified above.

The final review added source fingerprints **after** the paired measurements,
without changing measured operations or any production source. A later
simplification removed a duplicate output field, leaving the current harness
hash as
`0a3083dc7199765cc27386ba5e2f0bd14e6287b2035a751a340a81681df4a8f6`;
the earlier hash above identifies the exact measurement harness revision.
Tiny baseline/candidate smoke runs and an independent identity read verified:

- Baseline source tree: `c031fad4d2ce4f8f4cec29976995de6aa279c458dc6d7edb3749531067f97f2b`;
  HEAD/dirty unavailable for the archive.
- Candidate source tree: `e042a07160e12fd3367ae28b855925fc2149463fc2335639a7926a9c3c936eec`;
  HEAD is the baseline commit, **dirty: true**.

Each fingerprint covers 155 files: sorted relative `src/**/*` paths plus
`package.json`, `bun.lock`, `tsconfig.json`, and `tsdown.config.ts`. The framing
is JSON of `[relativePath, byteLength, contentSha256]` entries, hashed with
SHA-256. It deliberately excludes docs, node_modules and private local config.
`tests/tokenizer-benchmark-identity.test.ts` proves stable ordering, ignored
unrelated files, and a changed source digest despite unchanged HEAD identity.
These fingerprints identify the source, while the bundle/tarball hashes above
identify different artifacts; neither is substituted for the other.

## Validation

Final complete local gate after the review fixes:

- `bun run lint:all`: passed.
- `bun run typecheck`: passed.
- Main prescribed test group: 910 pass, 0 fail, 2,350 assertions.
- Isolated token-file/removal-refresh group: 38 pass, 0 fail, 203 assertions.
- Total: **948 pass, 0 fail, 2,553 assertions**.
- `bun run build`: passed.
- `bun run smoke:packaged`: passed on the freshly built candidate, including
  five tokenizer and ten other runtime probes under Bun and Node, debug
  contracts, and `bunx`/`npx` launchers.
- Frozen lockfile consistency check: passed with install scripts disabled.

The package smoke now fails if an isolated consumer install contains a separate
top-level `gpt-tokenizer` dependency or the packed manifest declares it as a
runtime dependency. Encoding selfchecks still run from the
installed bundle, so moving the manifest entry cannot hide a missing runtime
chunk.

The completed read-only CE review (`20260906-234202-a51f995d`) covered
correctness, project standards, testing, maintainability, security,
performance, reliability, local adversarial scenarios and relevant learnings.
It returned one actionable P2: dirty source identity was incomplete. One
bounded fix batch added the fingerprint and its regression test; no actionable
review finding was deferred. Cross-provider review was not run.

No commit, push, PR, release, active-service restart, or credential migration was
performed. Full removal remains blocked rather than marked complete.
