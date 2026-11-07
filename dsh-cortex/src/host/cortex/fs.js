/**
 * Host-side directory browser for the export path picker.
 *
 * The DSH desktop WebView cannot expose absolute paths through the browser's
 * File System Access API, so the export dialog asks the Host to list folders and
 * the user picks one. Read-only: no filesystem writes happen here.
 *
 *   GET /cortex-api/cortex/fs/list?path=<absolute or ~-prefixed> ->
 *     { path, parent, directories: [{ name, path }], home }
 */

import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { badRequest, sendJson } from '../http.js'

const MAX_PATH_LENGTH = 2000
const MAX_DIRECTORIES = 500

function expandTilde(value) {
  if (!value.startsWith('~')) return value
  return join(homedir(), value.replace(/^~[/\\]?/, ''))
}

function queryPath(searchParams) {
  const raw = searchParams && typeof searchParams.get === 'function' ? searchParams.get('path') : null
  if (raw === null || raw === undefined) return homedir()
  const trimmed = String(raw).trim()
  if (trimmed.length === 0) return homedir()
  if (trimmed.length > MAX_PATH_LENGTH) {
    throw badRequest('path is too long', { field: 'path', max: MAX_PATH_LENGTH })
  }
  const expanded = expandTilde(trimmed)
  if (!isAbsolute(expanded)) {
    throw badRequest('path must be an absolute path', { field: 'path' })
  }
  return resolve(expanded)
}

/** GET /fs/list — list subdirectories of one folder. */
export function handleList({ res, searchParams }) {
  const target = queryPath(searchParams)
  let stat
  try {
    stat = statSync(target)
  } catch {
    throw badRequest('directory does not exist', { field: 'path' })
  }
  if (!stat.isDirectory()) {
    throw badRequest('path is not a directory', { field: 'path' })
  }

  let entries
  try {
    entries = readdirSync(target, { withFileTypes: true })
  } catch {
    throw badRequest('cannot read directory', { field: 'path' })
  }
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(target, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_DIRECTORIES)

  const root = parse(target).root
  sendJson(res, 200, {
    path: target,
    parent: target === root ? null : dirname(target),
    directories,
    home: homedir(),
  })
}
