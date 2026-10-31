import { dirname, join } from 'node:path'

/**
 * Runtime locations of the shipped agent runtime.
 *
 * Installed layout (electron-builder `extraFiles`, see `electron-builder.yml`):
 * - Windows / Linux: `<install>/bin/{node(.exe), mcp-stdio.cjs, ctx.cjs, skills/}`
 * - macOS: `Cortex.app/Contents/bin/...` — the executable lives in
 *   `Cortex.app/Contents/MacOS/Cortex`, so the install root is the `Contents`
 *   directory (`dirname(dirname(process.execPath))`).
 *
 * Development builds resolve everything from the Electron app path instead; the
 * agent launches the same Node that started `npm run dev`.
 */

/** Root directory that contains the shipped `bin/` folder. */
export function installedRoot(execPath: string = process.execPath): string {
  const execDir = dirname(execPath)
  return process.platform === 'darwin' ? dirname(execDir) : execDir
}

/** `<root>/bin`: self-contained Node runtime + MCP/CLI bundles + skills. */
export function installedBinDir(execPath: string = process.execPath): string {
  return join(installedRoot(execPath), 'bin')
}

/** Bundled Node executable name: `node.exe` on Windows, `node` elsewhere. */
export function nodeExecutableName(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

/**
 * Node binary agent configs should launch in a development build.
 *
 * `npm run dev` exports `npm_node_execpath` (the Node that launched the script),
 * which is the most reliable choice from inside Electron's main process where
 * `process.execPath` is `electron.exe`. `CTX_NODE_BINARY` is the explicit
 * override (`PDH_NODE_BINARY` is its pre-rename alias), then plain `node` on PATH.
 */
export function developmentNodeCommand(env: NodeJS.ProcessEnv = process.env): string {
  return (
    nonEmpty(env['npm_node_execpath']) ??
    nonEmpty(env['CTX_NODE_BINARY']) ??
    nonEmpty(env['PDH_NODE_BINARY']) ??
    'node'
  )
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}
