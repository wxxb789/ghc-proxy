/**
 * Formats a millisecond duration as a compact human-readable string:
 * `<n>ms` under one second, otherwise `<n>s` rounded to whole seconds.
 */
export function formatDurationMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`
}
