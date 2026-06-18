import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const EXE_EXTENSION_RE = /\.exe$/i

type ShellName = 'bash' | 'zsh' | 'fish' | 'powershell' | 'cmd' | 'sh'
type EnvVars = Record<string, string | undefined>

function normalizeShellName(raw: string | undefined): ShellName | undefined {
  if (!raw) {
    return undefined
  }

  const normalized = path.basename(raw).toLowerCase().replace(EXE_EXTENSION_RE, '')

  switch (normalized) {
    case 'pwsh':
    case 'powershell': {
      return 'powershell'
    }
    case 'cmd': {
      return 'cmd'
    }
    case 'bash': {
      return 'bash'
    }
    case 'zsh': {
      return 'zsh'
    }
    case 'fish': {
      return 'fish'
    }
    case 'sh': {
      return 'sh'
    }
    default: {
      return undefined
    }
  }
}

function detectWindowsShellFromEnv(env: NodeJS.ProcessEnv): ShellName | undefined {
  if (
    env.PSModulePath
    || env.PSExecutionPolicyPreference
    || env.POWERSHELL_DISTRIBUTION_CHANNEL
  ) {
    return 'powershell'
  }

  const shellHints = [
    env.CODEX_SHELL,
    env.npm_config_script_shell,
    env.SHELL,
    env.ComSpec,
  ]

  for (const hint of shellHints) {
    const detectedShell = normalizeShellName(hint)
    if (detectedShell) {
      return detectedShell
    }
  }

  return undefined
}

function detectWindowsShellFromParent(ppid: number): ShellName | undefined {
  try {
    const parentProcess = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${ppid}").Name`,
      ],
      { stdio: 'pipe' },
    )
      .toString()
      .trim()

    return normalizeShellName(parentProcess)
  }
  catch {
    return undefined
  }
}

function getShell(): ShellName {
  const { platform, ppid, env } = process

  if (platform === 'win32') {
    return detectWindowsShellFromEnv(env)
      ?? detectWindowsShellFromParent(ppid)
      ?? 'cmd'
  }
  else {
    const shellPath = env.SHELL
    const detectedShell = normalizeShellName(shellPath)
    if (
      detectedShell
      && detectedShell !== 'cmd'
      && detectedShell !== 'powershell'
    ) {
      return detectedShell
    }

    return 'sh'
  }
}

function escapeForPowerShell(value: string): string {
  return `'${value.replaceAll('\'', '\'\'')}'`
}

function escapeForCmd(value: string): string {
  return value.replaceAll('"', '""')
}

/**
 * Generates a copy-pasteable script to set multiple environment variables
 * and run a subsequent command.
 * @param {EnvVars} envVars - An object of environment variables to set.
 * @param {string} commandToRun - The command to run after setting the variables.
 * @returns {string} The formatted script string.
 */
export function generateEnvScript(
  envVars: EnvVars,
  commandToRun: string = '',
): string {
  const shell = getShell()
  const filteredEnvVars = Object.entries(envVars).filter(
    ([, value]) => value !== undefined,
  ) as Array<[string, string]>

  let commandBlock: string

  switch (shell) {
    case 'powershell': {
      commandBlock = filteredEnvVars
        .map(([key, value]) => `$env:${key} = ${escapeForPowerShell(value)}`)
        .join('; ')
      break
    }
    case 'cmd': {
      commandBlock = filteredEnvVars
        .map(([key, value]) => `set "${key}=${escapeForCmd(value)}"`)
        .join(' & ')
      break
    }
    case 'fish': {
      commandBlock = filteredEnvVars
        .map(([key, value]) => `set -gx ${key} ${value}`)
        .join('; ')
      break
    }
    default: {
      // bash, zsh, sh
      const assignments = filteredEnvVars
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
      commandBlock = filteredEnvVars.length > 0 ? `export ${assignments}` : ''
      break
    }
  }

  if (commandBlock && commandToRun) {
    const separator = shell === 'cmd' ? ' & ' : ' && '
    return `${commandBlock}${separator}${commandToRun}`
  }

  return commandBlock || commandToRun
}
