#!/usr/bin/env node
/**
 * Ship the Windows credential helper in the npm artifact.
 *
 * dist/ is wiped by tsdown on every build, so this runs after `bun run build`
 * (see the prepack script) and only writes dist/msc-auth at pack time.
 *
 * Resolution order:
 *   1. MSC_AUTH_DIR is set  -> copy a prebuilt helper from that directory
 *   2. win32 with dotnet    -> native AOT publish from msc-auth/
 *   3. anything else        -> skip; the helper is Windows-only by design
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const TARGET = path.join('dist', 'msc-auth')
const PAYLOAD = /\.(?:exe|dll)$/i
const REQUIRED = ['msc-auth.exe', 'msalruntime.dll']

function fail(message) {
  console.error(`[msc-auth] ${message}`)
  process.exit(1)
}

function ship(names) {
  const missing = REQUIRED.filter(name => !names.includes(name))
  if (missing.length > 0) {
    fail(`missing ${missing.join(', ')} in ${TARGET}`)
  }
  console.log(`[msc-auth] shipping ${names.join(', ')}`)
}

function copyPrebuilt(source) {
  if (!fs.existsSync(source)) {
    fail(`MSC_AUTH_DIR does not exist: ${source}`)
  }
  fs.mkdirSync(TARGET, { recursive: true })
  const names = fs.readdirSync(source).filter(name => PAYLOAD.test(name))
  if (names.length === 0) {
    fail(`no .exe/.dll in MSC_AUTH_DIR: ${source}`)
  }
  for (const name of names) {
    fs.copyFileSync(path.join(source, name), path.join(TARGET, name))
  }
  return names
}

function publish() {
  fs.rmSync(TARGET, { recursive: true, force: true })
  const result = spawnSync('dotnet', [
    'publish',
    'msc-auth',
    '-c',
    'Release',
    '-r',
    'win-x64',
    '-p:PublishAot=true',
    '-p:DebugType=none',
    '-o',
    TARGET,
  ], { stdio: 'inherit' })
  if (result.error) {
    fail(`dotnet publish could not start: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(`dotnet publish exited ${result.status}`)
  }
  for (const name of fs.readdirSync(TARGET)) {
    if (name.endsWith('.pdb')) {
      fs.rmSync(path.join(TARGET, name))
    }
  }
  return fs.readdirSync(TARGET).filter(name => PAYLOAD.test(name))
}

const source = process.env.MSC_AUTH_DIR
if (source) {
  ship(copyPrebuilt(source))
}
else if (process.platform === 'win32') {
  ship(publish())
}
else {
  console.log('[msc-auth] skipped: the helper is a Windows-only binary')
}
