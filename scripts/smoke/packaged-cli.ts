import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { decodeOutput, extractTrailingJson, runCommand, tryParseJsonOrUndefined } from '../lib/cli-exec'

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
  'dashboard-bundle-contract',
  'dashboard-node-listener-boundary',
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
      bin?: string | Record<string, string>
    }

    const packagedBin = typeof packagedPackageJson.bin === 'string'
      ? packagedPackageJson.bin
      : packagedPackageJson.bin?.['ghc-proxy']

    if (!packagedBin) {
      throw new Error('Packaged package.json does not expose the ghc-proxy bin.')
    }

    const packagedBinPath = path.join(packagedRoot, packagedBin)
    await fs.access(packagedBinPath)

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
    // Run under BOTH Bun and Node: Bun matches the dev runtime, Node matches
    // the npm-installed end-user runtime (the package declares engines.node
    // and the bin is `node`-loadable via the .bin shim). The two ESM
    // resolvers and dynamic-import code paths differ enough that a rolldown
    // 1.x regression can pass under one and fail under the other.
    runSelfcheck('bun', packagedBinPath, installRoot)
    runSelfcheck('node', packagedBinPath, installRoot)

    const probeCount = EXPECTED_TOKENIZER_PROBES.length + EXPECTED_RUNTIME_PROBES.length
    console.log(`Packaged CLI smoke test passed for ${packagedPackageJson.name ?? 'ghc-proxy'}. (${probeCount} tokenizer/runtime probes passed under bun + node)`)
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

function runSelfcheck(runtime: 'bun' | 'node', packagedBinPath: string, cwd: string): void {
  const result = Bun.spawnSync([runtime, packagedBinPath, 'selfcheck', '--json'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
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
    if (report.ok && report.failedCount === 0 && failures.length === 0 && missing.length === 0) {
      return
    }
    const detail = [
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

function missingProbeNames(expected: Array<string>, actual: Array<string>): Array<string> {
  const actualNames = new Set(actual)
  return expected.filter(name => !actualNames.has(name))
}

await main()
