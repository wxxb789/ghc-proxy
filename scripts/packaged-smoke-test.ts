import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const TRAILING_JSON_ARRAY_RE = /(\[\s*\{[\s\S]*\}\s*\])\s*$/

interface NpmPackResult {
  filename: string
}

function extractPackJson(output: string): string {
  const trimmed = output.trim()
  const trailingJsonMatch = trimmed.match(TRAILING_JSON_ARRAY_RE)

  if (trailingJsonMatch?.[1]) {
    return trailingJsonMatch[1]
  }

  const jsonStart = Math.max(
    trimmed.lastIndexOf('[\n'),
    trimmed.lastIndexOf('[\r\n'),
  )
  if (jsonStart >= 0) {
    return trimmed.slice(jsonStart)
  }

  return trimmed
}

function decodeOutput(output: Uint8Array): string {
  return new TextDecoder().decode(output).trim()
}

function runCommand(command: Array<string>, cwd: string) {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (result.exitCode !== 0) {
    const stderr = decodeOutput(result.stderr)
    const stdout = decodeOutput(result.stdout)
    throw new Error(
      `Command failed: ${command.join(' ')}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )
  }

  return result
}

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
    const packOutput = extractPackJson(decodeOutput(packResult.stdout))
    const parsed = JSON.parse(packOutput) as Array<NpmPackResult>
    const tarballName = parsed[0]?.filename

    if (!tarballName) {
      throw new Error(`npm pack did not return a tarball filename: ${packOutput}`)
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

    console.log(`Packaged CLI smoke test passed for ${packagedPackageJson.name ?? 'ghc-proxy'}.`)
  }
  finally {
    if (tarballPath) {
      await fs.rm(tarballPath, { force: true })
    }
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

await main()
