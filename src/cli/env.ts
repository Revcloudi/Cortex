/**
 * Environment-variable lookup with legacy alias support.
 *
 * Runtime names were renamed from the old `PDH_` / `PHUB_` prefixes to `CTX_`;
 * every reader accepts the new name first and falls back to the old one so an
 * existing installation keeps working after the Cortex upgrade. The first
 * *non-empty* value wins.
 */
export function envOverride(env: NodeJS.ProcessEnv, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}
