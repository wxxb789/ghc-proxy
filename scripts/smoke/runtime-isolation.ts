import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { decodeOutput, runCommand } from '../lib/cli-exec'

export type RuntimeName = 'bun' | 'node'

export interface RuntimeEnvironment {
  runtime: RuntimeName
  executable: string
  env: NodeJS.ProcessEnv
}

async function resolveRuntimeExecutable(runtime: RuntimeName, cwd: string): Promise<string> {
  const executable = Bun.which(runtime)
  if (!executable)
    throw new Error(`Packaged smoke requires '${runtime}' on the harness PATH.`)

  // Ask the runtime itself: version-manager shims may also be named bun/node.
  const result = runCommand([executable, '-e', 'process.stdout.write(process.execPath)'], cwd)
  return fs.realpath(decodeOutput(result.stdout))
}

export async function createRuntimeEnvironment(
  runtime: RuntimeName,
  root: string,
  cwd: string,
): Promise<RuntimeEnvironment> {
  const runtimeRoot = path.join(root, runtime)
  const directories = Object.fromEntries(
    ['bin', 'home', 'config', 'cache', 'data', 'temp'].map(name => [name, path.join(runtimeRoot, name)]),
  ) as Record<'bin' | 'home' | 'config' | 'cache' | 'data' | 'temp', string>
  await Promise.all(Object.values(directories).map(directory => fs.mkdir(directory, { recursive: true })))

  const executable = path.join(directories.bin, process.platform === 'win32' ? `${runtime}.exe` : runtime)
  await fs.copyFile(await resolveRuntimeExecutable(runtime, cwd), executable)
  if (process.platform !== 'win32')
    await fs.chmod(executable, 0o755)

  // Keep package-manager configuration at its original path so registry auth
  // and relative CA paths survive HOME isolation without copying credentials.
  const userConfig = decodeOutput(runCommand(['npm', 'config', 'get', 'userconfig'], cwd).stdout)
  const globalConfig = decodeOutput(runCommand(['npm', 'config', 'get', 'globalconfig'], cwd).stdout)

  // Keep OS settings (including SystemRoot/ComSpec on Windows), but replace
  // lookup and user-storage locations. This is not an OS sandbox.
  const env = { ...process.env }
  const replacedKeys: Record<string, true> = {
    PATH: true,
    HOME: true,
    USERPROFILE: true,
    HOMEDRIVE: true,
    HOMEPATH: true,
    APPDATA: true,
    LOCALAPPDATA: true,
    XDG_CONFIG_HOME: true,
    XDG_CACHE_HOME: true,
    XDG_DATA_HOME: true,
    TMPDIR: true,
    TMP: true,
    TEMP: true,
    BUN_INSTALL: true,
    BUN_INSTALL_CACHE_DIR: true,
    NPM_CONFIG_CACHE: true,
    NPM_CONFIG_USERCONFIG: true,
    NPM_CONFIG_GLOBALCONFIG: true,
    NPM_CONFIG_PREFIX: true,
  }
  for (const key of Object.keys(env)) {
    if (Object.hasOwn(replacedKeys, key.toUpperCase()))
      delete env[key]
  }
  const homeDrive = path.parse(directories.home).root.slice(0, -1)
  Object.assign(env, {
    PATH: directories.bin,
    HOME: directories.home,
    USERPROFILE: directories.home,
    HOMEDRIVE: homeDrive,
    HOMEPATH: directories.home.slice(homeDrive.length),
    APPDATA: directories.config,
    LOCALAPPDATA: directories.data,
    XDG_CONFIG_HOME: directories.config,
    XDG_CACHE_HOME: directories.cache,
    XDG_DATA_HOME: directories.data,
    TMPDIR: directories.temp,
    TMP: directories.temp,
    TEMP: directories.temp,
    BUN_INSTALL: runtimeRoot,
    BUN_INSTALL_CACHE_DIR: directories.cache,
    npm_config_cache: directories.cache,
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    npm_config_prefix: runtimeRoot,
  })

  const environment = { runtime, executable, env }
  const oppositeRuntime = runtime === 'bun' ? 'node' : 'bun'
  // Windows also searches beside the running executable. Copying it above is
  // essential: trimming PATH alone does not hide its original sibling runtime.
  const result = runIsolatedRuntime(environment, [
    '-e',
    `const { spawnSync } = require('node:child_process');
const result = spawnSync(${JSON.stringify(oppositeRuntime)}, ['--version'], { stdio: 'pipe' });
if (result.error?.code !== 'ENOENT') {
  console.error('Opposite runtime must fail to spawn with ENOENT:', result.error, result.status);
  process.exit(1);
}`,
  ], cwd)
  if (result.exitCode !== 0) {
    throw new Error(`'${runtime}' isolation did not hide '${oppositeRuntime}'.\n${decodeOutput(result.stdout)}\n${decodeOutput(result.stderr)}`)
  }
  return environment
}

export function runIsolatedRuntime(environment: RuntimeEnvironment, args: Array<string>, cwd: string) {
  return Bun.spawnSync([environment.executable, ...args], {
    cwd,
    env: environment.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

export async function resolveNpxEntrypoint(cwd: string): Promise<string> {
  const nodeExecutable = await resolveRuntimeExecutable('node', cwd)
  const npxExecutable = Bun.which('npx')
  const resolvedNpx = npxExecutable ? await fs.realpath(npxExecutable) : undefined
  const npmRoot = decodeOutput(runCommand(['npm', 'root', '--global'], cwd).stdout)
  const binaryDirectories = [path.dirname(nodeExecutable), ...(resolvedNpx ? [path.dirname(resolvedNpx)] : [])]
  const candidates = [
    ...(resolvedNpx && path.basename(resolvedNpx) === 'npx-cli.js' ? [resolvedNpx] : []),
    ...binaryDirectories.flatMap(directory => [
      path.join(directory, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
      path.join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    ]),
    path.join(npmRoot, 'npm', 'bin', 'npx-cli.js'),
  ]
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile())
        return fs.realpath(candidate)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }
  }
  throw new Error(`Cannot locate the installed npm npx-cli.js entrypoint. Checked:\n${candidates.join('\n')}`)
}
