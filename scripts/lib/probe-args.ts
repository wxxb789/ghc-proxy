/**
 * Shared CLI-argument parsing for probe/smoke/matrix scripts.
 *
 * Centralizes the `--json` / `--model=<id>` idiom that was previously
 * reinvented per-script with three different styles (`rawArgs.includes`,
 * `Bun.argv.includes`, `Set.has`).
 */

function defaultArgv(): Array<string> {
  return Bun.argv.slice(2)
}

export interface ProbeArgs {
  /** `--json` present: emit machine-readable output and silence logs. */
  jsonMode: boolean
  /** `--model=<id>` value, if provided. */
  requestedModelId?: string
  /** All raw args, for scripts that parse additional one-off flags. */
  rest: Array<string>
}

/**
 * Parse the common `--json` + `--model=<id>` flags shared by every probe.
 */
export function parseProbeArgs(argv: Array<string> = defaultArgv()): ProbeArgs {
  return {
    jsonMode: hasFlag('--json', argv),
    requestedModelId: getFlagValue('--model', argv),
    rest: argv,
  }
}

/**
 * Whether a boolean flag (e.g. `--offline`, `--json`) is present.
 */
export function hasFlag(name: string, argv: Array<string> = defaultArgv()): boolean {
  return argv.includes(name)
}

/**
 * Read a `--name=value` flag's value, or `undefined` if absent.
 */
export function getFlagValue(name: string, argv: Array<string> = defaultArgv()): string | undefined {
  const prefix = `${name}=`
  return argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
}
