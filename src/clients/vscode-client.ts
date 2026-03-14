import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const FALLBACK = '1.104.3'
const execFileAsync = promisify(execFile)
const NEWLINE_RE = /\r?\n/
const SEMVER_RE = /^\d+\.\d+\.\d+$/
const PKGVER_RE = /pkgver=([0-9.]+)/

function extractVersion(text: string): string | undefined {
  const versionLine = text
    .split(NEWLINE_RE)
    .map(line => line.trim())
    .find(line => SEMVER_RE.test(line))

  return versionLine || undefined
}

async function getRemoteVSCodeVersion(): Promise<string | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 5000)

  try {
    const response = await fetch(
      'https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=visual-studio-code-bin',
      {
        signal: controller.signal,
      },
    )

    const pkgbuild = await response.text()
    const pkgverRegex = PKGVER_RE
    const match = pkgbuild.match(pkgverRegex)

    return match?.[1]
  }
  catch {
    return undefined
  }
  finally {
    clearTimeout(timeout)
  }
}

async function getVSCodeVersionFromCommand(): Promise<string | undefined> {
  const commands = process.platform === 'win32'
    ? ['code.cmd', 'code-insiders.cmd', 'code']
    : ['code', 'code-insiders']

  for (const command of commands) {
    try {
      const result = await execFileAsync(command, ['--version'], {
        timeout: 3000,
        windowsHide: true,
      })
      const version = extractVersion(result.stdout)
      if (version) {
        return version
      }
    }
    catch {
      continue
    }
  }

  return undefined
}

function getVSCodePackageJsonCandidates(): Array<string> {
  const homeDirectory = os.homedir()
  const candidates = new Set<string>([
    '/usr/share/code/resources/app/package.json',
    '/usr/share/code-insiders/resources/app/package.json',
    '/var/lib/flatpak/app/com.visualstudio.code/current/active/files/extra/vscode/resources/app/package.json',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/package.json',
    '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/package.json',
    path.join(homeDirectory, 'Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'package.json'),
    path.join(homeDirectory, 'Applications', 'Visual Studio Code - Insiders.app', 'Contents', 'Resources', 'app', 'package.json'),
  ])

  const windowsRoots = [
    process.env.LOCALAPPDATA,
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
  ].filter((value): value is string => Boolean(value))

  for (const root of windowsRoots) {
    candidates.add(
      path.join(root, 'Programs', 'Microsoft VS Code', 'resources', 'app', 'package.json'),
    )
    candidates.add(
      path.join(root, 'Programs', 'Microsoft VS Code Insiders', 'resources', 'app', 'package.json'),
    )
    candidates.add(
      path.join(root, 'Microsoft VS Code', 'resources', 'app', 'package.json'),
    )
    candidates.add(
      path.join(root, 'Microsoft VS Code Insiders', 'resources', 'app', 'package.json'),
    )
  }

  return [...candidates]
}

async function getVSCodeVersionFromPackageJson(): Promise<string | undefined> {
  const candidates = getVSCodePackageJsonCandidates()

  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate, 'utf8')
      const parsed = JSON.parse(content) as { version?: string }
      if (parsed.version) {
        return parsed.version
      }
    }
    catch {
      continue
    }
  }

  return undefined
}

async function getLocalVSCodeVersion(): Promise<string | undefined> {
  return (
    await getVSCodeVersionFromCommand()
    ?? await getVSCodeVersionFromPackageJson()
  )
}

export async function getVSCodeVersion() {
  const [remoteVersion, localVersion] = await Promise.all([
    getRemoteVSCodeVersion(),
    getLocalVSCodeVersion(),
  ])

  return remoteVersion ?? localVersion ?? FALLBACK
}
