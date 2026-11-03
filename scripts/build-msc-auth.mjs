#!/usr/bin/env bun
/**
 * Prepare the Windows helper after tsdown, or before a source `start`.
 * `build` runs this after tsdown clears dist/; `prepack` delegates to `build`.
 * Source startup reuses a complete, unchanged native build, accepts an explicit
 * helper override without compiling, or copies MSC_AUTH_DIR before publishing.
 * Non-Windows source startup skips the Windows-only helper.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'citty'

const SCRIPT = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SCRIPT), '..')
const PROJECT = path.join(ROOT, 'msc-auth')
const TARGET = path.join(ROOT, 'dist', 'msc-auth')
const BUILD_STATE = path.join(TARGET, '.build-state.json')
const PAYLOAD = /\.(?:exe|dll)$/i
const SOURCE_INPUT_RE = /\.(?:cs|csproj|props|targets|resx)$/i
const REQUIRED = ['msc-auth.exe', 'msalruntime.dll']
const SOURCE_OUTPUTS = new Set(['bin', 'obj', 'out', '.git'])
const start = process.argv[2] === '--start'
const cliArgs = start ? process.argv.slice(3) : []

function fail(message) {
  console.error(`[msc-auth] ${message}`)
  process.exit(1)
}

function requirePayload(directory, exeName = REQUIRED[0]) {
  const missing = [exeName, REQUIRED[1]].filter((name) => {
    const file = path.join(directory, name)
    const stat = fs.existsSync(file) ? fs.statSync(file) : undefined
    return !stat?.isFile() || stat.size === 0
  })
  if (missing.length > 0) {
    fail(`missing or empty ${missing.join(', ')} in ${directory}`)
  }
}

function payloadNames(directory) {
  return fs.readdirSync(directory).filter(name => PAYLOAD.test(name) && fs.statSync(path.join(directory, name)).isFile()).sort()
}

function ship(names) {
  requirePayload(TARGET)
  console.log(`[msc-auth] ready: ${names.join(', ')} in ${TARGET}`)
}

function copyPrebuilt(source) {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    fail(`MSC_AUTH_DIR is not a directory: ${source}`)
  }
  requirePayload(source)
  const names = payloadNames(source)
  fs.mkdirSync(TARGET, { recursive: true })
  if (fs.realpathSync(source) !== fs.realpathSync(TARGET)) {
    for (const name of names) {
      fs.copyFileSync(path.join(source, name), path.join(TARGET, name))
    }
  }
  // A prebuilt payload is authoritative, not evidence of a local source build.
  fs.rmSync(BUILD_STATE, { force: true })
  return names
}

function fileState(file) {
  const stat = fs.statSync(file)
  return [path.relative(ROOT, file), stat.mtimeMs, stat.size]
}

/** Record source paths too, so adding or deleting a helper class rebuilds it. */
function sourceState() {
  const sources = [fileState(SCRIPT)]
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name)
      if (fs.statSync(file).isDirectory()) {
        if (!SOURCE_OUTPUTS.has(name)) {
          visit(file)
        }
      }
      else if (SOURCE_INPUT_RE.test(name)) {
        sources.push(fileState(file))
      }
    }
  }
  visit(PROJECT)
  return sources
}

function buildState(sources) {
  return JSON.stringify({ sources, payload: REQUIRED.map(name => fileState(path.join(TARGET, name))) })
}

/** DLL timestamps can predate our sources because NuGet preserves them. */
function isUpToDate(sources) {
  try {
    if (REQUIRED.some((name) => {
      const stat = fs.statSync(path.join(TARGET, name))
      return !stat.isFile() || stat.size === 0
    })) {
      return false
    }
    return fs.readFileSync(BUILD_STATE, 'utf8') === buildState(sources)
  }
  catch {
    return false
  }
}

function publish() {
  const sources = sourceState()
  if (isUpToDate(sources)) {
    console.log(`[msc-auth] up to date: ${TARGET}`)
    return payloadNames(TARGET)
  }
  const env = { ...process.env }
  const programFiles = process.env['ProgramFiles(x86)']
  if (programFiles) {
    const installer = path.join(programFiles, 'Microsoft Visual Studio', 'Installer')
    if (fs.existsSync(path.join(installer, 'vswhere.exe'))) {
      // VS invokes bare vswhere.exe; Bun disables implicit current-directory search.
      // Scope the installed tool's PATH entry to dotnet, preserving that security policy.
      const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
      env[pathKey] = `${installer}${path.delimiter}${env[pathKey] ?? ''}`
    }
  }
  fs.rmSync(TARGET, { recursive: true, force: true })
  const result = spawnSync('dotnet', [
    'publish',
    PROJECT,
    '-c',
    'Release',
    '-r',
    'win-x64',
    '-p:PublishAot=true',
    '-p:DebugType=none',
    '-o',
    TARGET,
  ], { stdio: 'inherit', env })
  if (result.error) {
    fail(`dotnet publish could not start: ${result.error.message}. Install the .NET 10 SDK and Windows native AOT build tools, or provide MSC_AUTH_DIR or an explicit source-start helper override.`)
  }
  if (result.status !== 0) {
    fail(`dotnet publish exited ${result.status}`)
  }
  for (const name of fs.readdirSync(TARGET)) {
    if (name.endsWith('.pdb')) {
      fs.rmSync(path.join(TARGET, name))
    }
  }
  requirePayload(TARGET)
  fs.writeFileSync(BUILD_STATE, buildState(sources))
  return payloadNames(TARGET)
}

function explicitHelper() {
  const args = parseArgs(cliArgs, { 'msc-auth-exe': { type: 'string' } })
  const exe = args['msc-auth-exe']
  if (exe !== undefined && (!exe || exe.startsWith('--'))) {
    fail('--msc-auth-exe requires a helper path')
  }
  return exe || process.env.GHC_MSC_AUTH_EXE
}

const override = start ? explicitHelper() : undefined
const source = process.env.MSC_AUTH_DIR
if (start && process.platform !== 'win32') {
  console.log('[msc-auth] skipped: the helper is Windows-only; GitHub startup is unaffected')
}
else if (override) {
  requirePayload(path.dirname(override), path.basename(override))
  console.log(`[msc-auth] using explicit helper: ${override}`)
}
else if (source) {
  ship(copyPrebuilt(source))
}
else if (process.platform === 'win32') {
  ship(publish())
}
else {
  console.log('[msc-auth] skipped: the helper is a Windows-only binary')
}

if (start) {
  const main = path.join(ROOT, 'src', 'main.ts')
  // Keep the original CLI argv and signal owner; do not wrap the proxy in a child.
  process.argv = [process.execPath, main, 'start', ...cliArgs]
  await import(pathToFileURL(main).href)
}
