import type { RuntimeEnvironment, RuntimeName } from './runtime-isolation'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import process from 'node:process'

import { decodeOutput, extractTrailingJson, includesTextIgnoringLineEndings, runCommand, tryParseJsonOrUndefined } from '../lib/cli-exec'

import { createRuntimeEnvironment, resolveNpxEntrypoint, runIsolatedRuntime } from './runtime-isolation'

interface NpmPackResult {
  filename: string
}

const EXPECTED_TOKENIZER_PROBES = [
  'o200k_base',
  'cl100k_base',
  'p50k_base',
  'p50k_edit',
  'r50k_base',
]

const EXPECTED_RUNTIME_PROBES = [
  'http-error-response-contract',
  'connection-error-classification',
  'response-body-cancellation',
  'response-commit-boundary',
  'caller-cancellation',
  'protocol-payload-contract',
  'credential-store-migration-contract',
  'dashboard-bundle-contract',
  'dashboard-node-listener-boundary',
  'account-hostname-routing',
  'legacy-single-account-routing-migration',
  'dashboard-node-quota-projection',
  'responses-chat-completions-bridge',
  'http-error-transport-contract',
  'server-lifecycle-contract',
]

async function main() {
  const repoRoot = process.cwd()
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ghc-proxy-packaged-smoke-'),
  )
  const installRoot = path.join(tempDir, 'install')

  let tarballPath: string | undefined

  try {
    await fs.mkdir(installRoot, { recursive: true })
    await fs.writeFile(
      path.join(installRoot, 'package.json'),
      JSON.stringify({ private: true }, null, 2),
    )

    const packResult = runCommand(
      ['npm', 'pack', '--json', '--ignore-scripts', '--silent'],
      repoRoot,
    )
    // npm pack --json --silent emits clean JSON on stdout. Parse it
    // directly; only fall back to the trailing-JSON heuristic if a runner
    // prepends noise. npm <=11 returns an array `[{ filename }]`; npm 12
    // returns an object keyed by package name `{ "<pkg>": { filename } }`.
    const rawStdout = decodeOutput(packResult.stdout).trim()
    const parsedRaw = (tryParseJsonOrUndefined(rawStdout)
      ?? JSON.parse(extractTrailingJson(rawStdout))) as
      | Array<NpmPackResult>
      | Record<string, NpmPackResult>
    const parsed = Array.isArray(parsedRaw)
      ? parsedRaw
      : Object.values(parsedRaw)
    const tarballName = parsed[0]?.filename

    if (!tarballName) {
      throw new Error(`npm pack did not return a tarball filename: ${rawStdout}`)
    }

    tarballPath = path.join(repoRoot, tarballName)
    runCommand(
      ['npm', 'install', '--silent', '--no-package-lock', tarballPath],
      installRoot,
    )

    const packagedRoot = path.join(installRoot, 'node_modules', 'ghc-proxy')
    const packagedPackageJsonPath = path.join(packagedRoot, 'package.json')
    const packagedPackageJson = JSON.parse(
      await fs.readFile(packagedPackageJsonPath, 'utf8'),
    ) as {
      name?: string
      version?: string
      bin?: string | Record<string, string>
      dependencies?: Record<string, string>
    }

    const packagedVersion = packagedPackageJson.version
    if (!packagedVersion) {
      throw new Error('Packaged package.json does not expose a version.')
    }

    const packagedBin = typeof packagedPackageJson.bin === 'string'
      ? packagedPackageJson.bin
      : packagedPackageJson.bin?.['ghc-proxy']

    if (!packagedBin) {
      throw new Error('Packaged package.json does not expose the ghc-proxy bin.')
    }

    const packagedBinPath = path.join(packagedRoot, packagedBin)
    if (packagedPackageJson.dependencies?.['gpt-tokenizer'])
      throw new Error('The packaged manifest declares the already-bundled gpt-tokenizer as a runtime dependency.')
    const [packagedNotices, tokenizerLicense, sourceNotices] = await Promise.all([
      fs.readFile(path.join(packagedRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
      fs.readFile(path.join(repoRoot, 'node_modules', 'gpt-tokenizer', 'LICENSE'), 'utf8'),
      fs.readFile(path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
    ])
    if (!includesTextIgnoringLineEndings(packagedNotices, tokenizerLicense))
      throw new Error('The packaged CLI does not preserve the bundled gpt-tokenizer license notice.')
    if (!includesTextIgnoringLineEndings(packagedNotices, sourceNotices))
      throw new Error('The packaged CLI does not preserve all bundled third-party notices.')
    // The encodings are bundled; installing their development package again
    // would add the full vocabulary/source tree to every consumer install.
    const installedTokenizer = await fs.stat(path.join(installRoot, 'node_modules', 'gpt-tokenizer'))
      .then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT')
          throw error
        return false
      })
    if (installedTokenizer)
      throw new Error('The packaged CLI installed the already-bundled gpt-tokenizer dependency.')
    const packagedBinSource = await fs.readFile(packagedBinPath, 'utf8')
    if (!packagedBinSource.startsWith('#!/usr/bin/env node\n')) {
      throw new Error('Packaged CLI bin must use a Node.js shebang so npx works without Bun installed.')
    }

    const shimCandidates = process.platform === 'win32'
      ? [
          path.join(installRoot, 'node_modules', '.bin', 'ghc-proxy.cmd'),
          path.join(installRoot, 'node_modules', '.bin', 'ghc-proxy'),
        ]
      : [path.join(installRoot, 'node_modules', '.bin', 'ghc-proxy')]

    let shimExists = false
    for (const candidate of shimCandidates) {
      try {
        await fs.access(candidate)
        shimExists = true
        break
      }
      catch {
        continue
      }
    }

    if (!shimExists) {
      throw new Error('Installed package did not produce a ghc-proxy executable shim.')
    }

    const helpResult = runCommand(['bun', packagedBinPath, '--help'], installRoot)
    const helpText = `${decodeOutput(helpResult.stdout)}\n${decodeOutput(helpResult.stderr)}`

    if (!helpText.includes('ghc-proxy')) {
      throw new Error(`Packaged CLI help output did not mention ghc-proxy.\n${helpText}`)
    }

    // selfcheck loads every gpt-tokenizer dynamic chunk against the packaged
    // bundle — this is the only end-to-end check that exercises the
    // multi-chunk import graph in dist/, catching bundler regressions
    // (cross-chunk __toESM, lazyBarrel side-effect drops, etc.) that the
    // help-text check alone cannot.
    //
    // The harness needs both runtimes, but each installed CLI run gets only
    // its selected executable, with temporary user/config/cache directories.
    const npxEntrypoint = await resolveNpxEntrypoint(installRoot)
    for (const runtime of ['bun', 'node'] as const) {
      const environment = await createRuntimeEnvironment(runtime, tempDir, installRoot)
      runSelfcheck(environment, packagedBinPath, installRoot)
      runDebugCheck(environment, [packagedBinPath, 'debug', '--json'], installRoot, packagedVersion, 'direct CLI')
      const launcher = runtime === 'bun' ? 'bunx' : 'npx'
      const launcherArgs = runtime === 'bun'
        ? ['x', '--bun', '--no-install', 'ghc-proxy', 'debug', '--json']
        : [npxEntrypoint, '--no-install', 'ghc-proxy', 'debug', '--json']
      runDebugCheck(environment, launcherArgs, installRoot, packagedVersion, launcher)

      // Preserve the existing online tarball-install launcher coverage separately
      // from the no-install contract; offline runs reuse the npm-installed package.
      if (runtime === 'bun' && process.env.npm_config_offline !== 'true') {
        runDebugCheck(environment, ['x', '--bun', '--package', tarballPath, 'ghc-proxy', 'debug', '--json'], installRoot, packagedVersion, 'bunx tarball install')
      }
    }

    const probeCount = EXPECTED_TOKENIZER_PROBES.length + EXPECTED_RUNTIME_PROBES.length
    console.log(`Packaged CLI smoke test passed for ${packagedPackageJson.name ?? 'ghc-proxy'}. (${probeCount} tokenizer/runtime probes plus debug contract passed with isolated bun + node, bunx + npx launcher coverage)`)
  }
  finally {
    if (tarballPath) {
      await fs.rm(tarballPath, { force: true })
    }
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

interface SelfcheckProbe {
  encoding: string
  ok: boolean
  tokenCount?: number
  error?: string
}

interface RuntimeProbe {
  name: string
  ok: boolean
  error?: string
}

interface SelfcheckReport {
  ok?: boolean
  probes?: Array<SelfcheckProbe>
  runtimeProbes?: Array<RuntimeProbe>
  failedCount?: number
}

interface DebugReport {
  credentialError?: string
  credentialMigrationPending?: boolean
  paths?: {
    CONFIG_MIGRATION_BACKUP_PATH?: string
    CREDENTIALS_PATH?: string
  }
  version?: string
  runtime?: {
    name?: string
    version?: string
  }
  tokenExists?: boolean
}

function runSelfcheck(environment: RuntimeEnvironment, packagedBinPath: string, cwd: string): void {
  const { runtime } = environment
  const result = runIsolatedRuntime(environment, [packagedBinPath, 'selfcheck', '--json'], cwd)
  const stdout = decodeOutput(result.stdout)
  const stderr = decodeOutput(result.stderr)

  // Parse the JSON FIRST so a structured probe failure produces a clearly
  // formatted error message. Fall back to the raw exit-code path only when
  // selfcheck failed before emitting parseable JSON.
  const report = tryParseJsonOrUndefined<SelfcheckReport>(stdout)

  if (report) {
    const tokenizerProbes = report.probes ?? []
    const runtimeProbes = report.runtimeProbes ?? []
    const failures = [
      ...tokenizerProbes.filter(p => !p.ok).map(p => `${p.encoding}: ${p.error ?? 'unknown error'}`),
      ...runtimeProbes.filter(p => !p.ok).map(p => `${p.name}: ${p.error ?? 'unknown error'}`),
    ]
    const missing = [
      ...missingProbeNames(EXPECTED_TOKENIZER_PROBES, tokenizerProbes.map(p => p.encoding)),
      ...missingProbeNames(EXPECTED_RUNTIME_PROBES, runtimeProbes.map(p => p.name)),
    ]
    if (result.exitCode === 0 && report.ok && report.failedCount === 0 && failures.length === 0 && missing.length === 0) {
      return
    }
    const detail = [
      ...(result.exitCode === 0 ? [] : [`  - child exited with code ${result.exitCode}`]),
      ...failures.map(failure => `  - ${failure}`),
      ...missing.map(name => `  - missing required probe: ${name}`),
    ].join('\n') || '  (selfcheck report shape unexpected)'
    throw new Error(
      `Packaged CLI selfcheck under '${runtime}' reported failures:\n${detail}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    )
  }

  throw new Error(
    `Packaged CLI selfcheck under '${runtime}' produced no parseable JSON (exit ${result.exitCode}).\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
  )
}

function runDebugCheck(
  environment: RuntimeEnvironment,
  args: Array<string>,
  cwd: string,
  expectedVersion: string,
  launcher: string,
): void {
  const result = runIsolatedRuntime(environment, args, cwd)
  const stdout = decodeOutput(result.stdout)
  const report = tryParseJsonOrUndefined<DebugReport>(stdout)

  if (result.exitCode !== 0 || !hasExpectedDebugContract(report, environment.runtime, expectedVersion)) {
    throw new Error(
      `Packaged CLI debug through ${launcher} under '${environment.runtime}' returned unexpected exit, version or runtime metadata (exit ${result.exitCode}).\n--- stdout ---\n${stdout}\n--- stderr ---\n${decodeOutput(result.stderr)}`,
    )
  }
}

function hasExpectedDebugContract(
  report: DebugReport | undefined,
  runtime: RuntimeName,
  expectedVersion: string,
): boolean {
  return report?.runtime?.name === runtime
    && Boolean(report.runtime.version)
    && report.version === expectedVersion
    && typeof report.tokenExists === 'boolean'
    && typeof report.credentialMigrationPending === 'boolean'
    && (report.credentialError === undefined || typeof report.credentialError === 'string')
    && report.paths?.CREDENTIALS_PATH?.endsWith('credentials.json') === true
    && report.paths.CONFIG_MIGRATION_BACKUP_PATH?.endsWith('config.json.github-token-migration.bak') === true
}

function missingProbeNames(expected: Array<string>, actual: Array<string>): Array<string> {
  const actualNames = new Set(actual)
  return expected.filter(name => !actualNames.has(name))
}

await main()
