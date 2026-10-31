/**
 * Cortex release version. Kept as a plain constant so the stdio MCP bundle and
 * the CLI still report the right version when run from a bundled/packaged layout
 * where `package.json` may not be importable.
 */
export const CORTEX_VERSION = '0.1.2'

/** @deprecated Pre-rename alias; use `CORTEX_VERSION`. */
export const PDH_VERSION = CORTEX_VERSION
