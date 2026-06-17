/**
 * Runtime-agnostic subprocess + output helpers for dev scripts that shell out
 * (e.g. the packaged-CLI smoke test).
 *
 * Deliberately free of any upstream/auth imports so consumers never pull token
 * or Copilot side-effects just to run a child process.
 */

const TRAILING_JSON_ARRAY_RE = /(\[\s*\{[\s\S]*\}\s*\])\s*$/

/**
 * Decode a spawn stream and trim surrounding whitespace.
 */
export function decodeOutput(output: Uint8Array): string {
  return new TextDecoder().decode(output).trim()
}

/**
 * Run a command synchronously, throwing a descriptive error on non-zero exit.
 * Returns the raw {@link Bun.spawnSync} result so callers can read stdout/stderr.
 */
export function runCommand(command: Array<string>, cwd: string) {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed: ${command.join(' ')}\n`
      + `stdout:\n${decodeOutput(result.stdout)}\n`
      + `stderr:\n${decodeOutput(result.stderr)}`,
    )
  }

  return result
}

/**
 * Extract a trailing JSON array from noisy command output (e.g. `npm pack`
 * that prints progress before the `--json` payload).
 */
export function extractTrailingJson(output: string): string {
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

/**
 * Parse JSON, returning `undefined` (not throwing) on malformed input.
 */
export function tryParseJsonOrUndefined<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  }
  catch {
    return undefined
  }
}
