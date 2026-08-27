# Dependency Upgrade Audit

**Audit date:** 2026-08-26

**Repository baseline:** `origin/main` and `HEAD` at `85f77b7`, zero divergence

**Registry for npm metadata and isolated installs:** `https://mirrors.tencent.com/npm/`

## Executive Verdict

Do not upgrade every dependency to its latest stable major in one sweep.

The worthwhile change now is a compatible security and maintenance refresh:

1. Upgrade `elysia` from `1.4.28` to `1.4.29`.
2. Upgrade `undici` from `7.24.3` to `7.29.0`, not `8.10.0`.
3. Refresh `bun.lock` so the Node adapter resolves `srvx >=0.11.13` and all
   vulnerable development transitive dependencies move to fixed versions.
4. Accept compatible updates for `@types/bun`, ESLint, lint-staged, tsdown,
   Antfu config 7.x, and Knip 5.x in the same validated batch.
5. Upgrade and SHA-pin `actions/checkout` separately, then pin the other mutable
   GitHub Action references.
6. Pin `changelogithub@15.0.4` instead of resolving an unversioned `bunx`
   command during a release.

This compatible batch resolved all `bun audit` findings and passed the full
local gate. The all-latest experiment produced two blocking regressions and
one low-value deferral:

- TypeScript 7 prevents ESLint from starting because typescript-eslint does
  not support the TypeScript 7 API model yet.
- Undici 8 breaks the packaged Node `response-body-cancellation` contract.
- Knip 6 does not make the already-noisy zero-config Knip report actionable;
  its output changes and remains non-zero, so there is no reason to take the
  major yet.

## Method

- Read `package.json`, `bun.lock`, runtime imports, build configuration,
  GitHub Actions workflows, and the Dockerfile.
- Queried every direct package through Tencent's npm mirror. No global npm or
  Bun registry configuration was changed.
- Used upstream GitHub releases, official documentation, and security
  advisories for migration and vulnerability facts.
- Scanned all exact lockfile versions through OSV and corroborated the result
  with `bun audit`.
- Created isolated detached worktrees for compatible and all-latest upgrades.
- Did not run `matrix:live` or consume Copilot quota.

## Security Findings

### Runtime findings

| Priority | Package | Current | Fixed target | Why it matters |
| --- | --- | ---: | ---: | --- |
| P0 | `elysia` | `1.4.28` | `1.4.29` | `1.4.28` is affected by `GHSA-9643-4qgh-g8mx` / `CVE-2026-56669`, a multipart CPU denial-of-service issue. |
| P0 | `undici` | `7.24.3` | `7.29.0` | The exact version matches 12 advisories, including SOCKS5 TLS/cross-origin issues, cache disclosure, WebSocket DoS, and request/response injection or desynchronization classes. |
| P0 for Node | `srvx` | `0.11.9` | `>=0.11.13` | `@elysiajs/node` reaches it in the supported Node fallback; the advisory permits middleware bypass through an absolute URI request line. |

The exact-version OSV scan found 10 vulnerable package/version instances and
29 distinct GHSAs. Adding the separately disclosed Elysia advisory yields an
overall total of 11 vulnerable exact versions and 30 distinct GHSAs in the
current graph. `bun audit` rendered its 10-version subset as 31
package/advisory associations. The remaining findings were development-only
descendants of ESLint, Antfu, Knip, lint-staged, bumpp, or tsdown:
`brace-expansion`, `flatted`, `nanoid`, `picomatch`, `postcss`, `smol-toml`,
and `yaml`.

The compatible Tencent-mirror update reported:

```text
No vulnerabilities found (checked 420 packages)
```

The lockfile itself has acceptable provenance: all 492 records have integrity
hashes, no resolved record uses a git/file/URL source, and `bun pm untrusted`
reported zero untrusted lifecycle-script packages.

## Direct Dependency Matrix

`Current` is the installed version from the audited lockfile. `Latest` is the
Tencent mirror's `latest` dist-tag on 2026-08-26.

### Runtime dependencies

| Package | Current | Latest | Decision |
| --- | ---: | ---: | --- |
| `@elysiajs/cors` | `1.4.2` | `1.4.2` | Keep. |
| `@elysiajs/node` | `1.4.5` | `1.4.5` | Keep the direct version; refresh its `srvx` transitive dependency. |
| `citty` | `0.2.2` | `0.2.2` | Keep. |
| `consola` | `3.4.2` | `3.4.2` | Keep. |
| `elysia` | `1.4.28` | `1.4.29` | Upgrade now for the security fix. |
| `fetch-event-stream` | `0.1.6` | `0.1.6` | Keep. |
| `gpt-tokenizer` | `3.4.0` | `4.0.0` | Defer. Existing encoding imports work in 4.0.0, but the proxy uses none of its new model metadata and gains little from the major today. |
| `proxy-from-env` | `2.1.0` | `2.1.0` | Keep. The manifest's `^2.0.0` already permits the installed latest version. |
| `undici` | `7.24.3` | `8.10.0` | Upgrade to `7.29.0` now. Block 8.x until its dispatcher/H2 migration preserves the packaged Node contract. |
| `zod` | `4.4.3` | `4.4.3` | Keep. |

### Development dependencies

| Package | Current | Latest | Decision |
| --- | ---: | ---: | --- |
| `@antfu/eslint-config` | `7.7.2` | `9.3.0` | Take `7.7.3` in the compatible batch. Consider 9.x later in a lint-only change; the tested config passed and the public v9 break is React-specific, which this repo does not use. |
| `@types/bun` | `1.3.14` | `1.4.0` | Upgrade now. Typecheck passed. |
| `@types/proxy-from-env` | `1.0.4` | `1.0.4` | Keep. |
| `bumpp` | `11.1.0` | `12.2.2` | Worth a separate low-risk release-tool update. Its used flags remain present, but do not test it by running a real release. |
| `eslint` | `10.4.1` | `10.9.1` | Upgrade now. Lint passed. |
| `knip` | `5.86.0` | `6.32.3` | Take `5.88.1` only as part of the compatible lock refresh. Defer 6.x until the repo defines a useful Knip configuration. The current 5.86.0 command already exits non-zero with many false positives. |
| `lint-staged` | `17.0.7` | `17.3.0` | Upgrade now. |
| `simple-git-hooks` | `2.13.1` | `2.13.1` | Keep. |
| `tsdown` | `0.22.2` | `0.22.14` | Upgrade now. Build and packaged smoke passed with Rolldown `1.2.6`. |
| `typescript` | `5.9.3` | `7.0.2` | Block. Use a dedicated TypeScript 6 migration first, then wait for typescript-eslint's TypeScript 7 support. |

## Other Supply-Chain Dependencies

### GitHub Actions

| Dependency | Repository state | Current stable | Decision |
| --- | --- | --- | --- |
| `actions/checkout` | Mostly mutable `@v4`; one Docker job uses `@v7`; Docker release is SHA-pinned | `v7.0.1` | Upgrade every reference to `3d3c42e5aac5ba805825da76410c181273ba90b1` and retain a version comment. |
| `actions/setup-node` | `@v7` or the verified v7 SHA | `v7.0.0` | Keep the major; SHA-pin mutable references. |
| `oven-sh/setup-bun` | `@v2` or the verified v2 SHA | `v2.2.0` | Keep the major; SHA-pin mutable references. |
| Docker build actions | Full SHAs in `release-docker.yml` | Current stable majors | Keep. |

GitHub recommends a full-length commit SHA when an immutable third-party
action reference is required. Add a reviewed GitHub Actions updater after
pinning so the repository does not trade upstream mutability for silent staleness.

### Runtime and container baseline

| Item | Repository state | Current on 2026-08-26 | Decision |
| --- | --- | --- | --- |
| Bun | Engine `>=1.4.0`; floor jobs use `1.4.0` | `1.4.0` stable | Keep. |
| Node.js | Engine `>=24`; CI follows LTS and also tests Current | LTS `24.20.0`, Current `26.8.0` | Keep the public floor at Node 24. |
| Docker base | `oven/bun:1.4.0-alpine` with digest `sha256:07235578...` | Tag resolves to the same multi-platform digest | Keep. |

### Unpinned release CLI

`release-npm.yml` runs `bunx changelogithub` without a version. Tencent's mirror
resolves the exact `changelogithub@15.0.4` package and tarball, but generic
dist-tag lookups were inconsistent during the audit. Pin the exact version in
the workflow or add it as an exact dev dependency so release behavior does not
depend on mirror cache state or a future `latest` retag.

## Empirical Validation

### Compatible update through Tencent mirror

The compatible worktree used:

```bash
bun update --registry=https://mirrors.tencent.com/npm/
```

Important direct resolutions were:

```text
elysia                  1.4.29
undici                  7.29.0
@antfu/eslint-config    7.7.3
@types/bun              1.4.0
eslint                  10.9.1
knip                    5.88.1
lint-staged             17.3.0
tsdown                  0.22.14
```

The full local gate passed:

- lint: pass
- typecheck: pass
- tests: 802 pass, 0 fail, 2,001 assertions
- build: pass with `tsdown 0.22.14` and `rolldown 1.2.6`
- packaged smoke: 13 tokenizer/runtime probes plus debug contract under Bun and
  Node, including bunx and npx launcher coverage
- audit: 0 vulnerabilities

The detached worktree's `simple-git-hooks` prepare step could not create
`.git/hooks` because a linked worktree has a `.git` file rather than a
directory. This is an isolation artifact, not an application or package
compatibility failure.

### All-latest experiment through Tencent mirror

The all-latest worktree resolved:

```text
gpt-tokenizer           4.0.0
undici                  8.10.0
@antfu/eslint-config    9.3.0
@types/bun              1.4.0
bumpp                   12.2.2
eslint                  10.9.1
knip                    6.32.3
typescript              7.0.2
```

Observed blockers:

1. With TypeScript 7 installed, `bun run lint:all` fails before linting:
   `typescript-eslint does not support TS 7.0.`
2. After restoring TypeScript 5.9.3, lint, typecheck, all 802 tests, and build
   pass, but `smoke:packaged` fails under Node at
   `response-body-cancellation: fetch failed` with Undici 8.
3. Restoring only Undici 7.29.0 makes the packaged smoke pass again. This
   isolates the runtime regression to Undici 8 rather than gpt-tokenizer 4,
   Antfu 9, bumpp 12, or the other updated packages.
4. `knip@6.32.3` still exits non-zero and expands the zero-config report. Since
   the baseline Knip command is already non-zero and is not part of CI, a major
   upgrade has no operational value until its intended project/entry surface
   is configured.
5. `bumpp@12.2.2 --help` retains the repository's required `--commit`, `--tag`,
   `--yes`, and push behavior. A real release was intentionally not run.

## Recommended Delivery Order

### 1. Security and compatible maintenance now

- Set the direct security floors to `elysia@^1.4.29` and `undici@^7.29.0`.
- Refresh the lockfile through Tencent's mirror.
- Accept the compatible direct versions listed above.
- Run the exact full local gate again in the canonical change.
- Keep `matrix:live` out of this dependency validation.

### 2. CI supply-chain hardening

- Upgrade and SHA-pin `actions/checkout@v7.0.1`.
- SHA-pin mutable `actions/setup-node@v7` and `oven-sh/setup-bun@v2` references.
- Pin `changelogithub@15.0.4`.
- Add reviewed automated updates for GitHub Actions pins.

### 3. Optional isolated majors

- `@antfu/eslint-config@9.3.0`: reasonable in a lint-only change.
- `bumpp@12.2.2`: reasonable after a non-pushing release rehearsal in a
  standalone disposable repository.
- `gpt-tokenizer@4.0.0`: technically compatible after the Undici rollback, but
  low-value until the proxy needs its new tokenizer/model metadata.

### 4. Explicitly defer

- `undici@8.10.0`: packaged Node contract regression plus HTTP/2/dispatcher
  migration risk.
- `typescript@7.0.2`: current ESLint stack cannot start with it.
- `knip@6.32.3`: first define an actionable Knip configuration and baseline.
- Elysia 2 prereleases: they are not stable and require an adapter migration.

## Primary Sources

- Elysia advisory: https://github.com/elysiajs/elysia/security/advisories/GHSA-9643-4qgh-g8mx
- Elysia 1.4.29: https://github.com/elysiajs/elysia/releases/tag/1.4.29
- Undici 7.29.0: https://github.com/nodejs/undici/releases/tag/v7.29.0
- Undici 8 migration/release: https://github.com/nodejs/undici/releases/tag/v8.0.0
- TypeScript 7: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- Antfu config 9: https://github.com/antfu/eslint-config/releases/tag/v9.0.0
- bumpp 12: https://github.com/antfu-collective/bumpp/releases/tag/v12.0.0
- tsdown 0.22.14: https://github.com/rolldown/tsdown/releases/tag/v0.22.14
- checkout 7.0.1: https://github.com/actions/checkout/releases/tag/v7.0.1
- GitHub Actions pinning: https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-guides/security-hardening-your-deployments#using-third-party-actions
- Node release index: https://nodejs.org/dist/index.json
- Tencent npm mirror used for metadata: https://mirrors.tencent.com/npm/
