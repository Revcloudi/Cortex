import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, File, Folder, Loader2 } from 'lucide-react'
import {
  getMiniappTree,
  toMiniappErrorMessage,
  type MiniappTreeEntry
} from '@renderer/lib/miniappApi'
import { formatBytes } from '@renderer/lib/format'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'

interface FileTreeProps {
  miniappId: string
  /** Called with the relative path when a file leaf is clicked. */
  onOpenFile: (path: string) => void
}

interface DirState {
  entries: MiniappTreeEntry[] | null
  loading: boolean
  error: string | null
}

/**
 * Lazy directory tree of an unpacked mini program.
 *
 * Only the root directory is fetched on mount; every expanded directory is
 * fetched exactly once and then cached for the lifetime of the mount. The
 * detail sheet keys the component by source id so switching sources resets the
 * cache instead of showing another app's tree.
 */
export function FileTree({ miniappId, onOpenFile }: FileTreeProps) {
  const { t } = useI18n()
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const loadDir = useCallback(
    async (path: string) => {
      setDirs((prev) => ({
        ...prev,
        [path]: { entries: prev[path]?.entries ?? null, loading: true, error: null }
      }))
      try {
        const result = await getMiniappTree(miniappId, path)
        setDirs((prev) => ({
          ...prev,
          [path]: { entries: result.entries ?? [], loading: false, error: null }
        }))
      } catch (cause) {
        setDirs((prev) => ({
          ...prev,
          [path]: { entries: null, loading: false, error: toMiniappErrorMessage(cause) }
        }))
      }
    },
    [miniappId]
  )

  useEffect(() => {
    setDirs({})
    setExpanded({})
    void loadDir('')
  }, [loadDir])

  const toggleDir = (path: string) => {
    if (expanded[path] === true) {
      setExpanded((prev) => ({ ...prev, [path]: false }))
      return
    }
    setExpanded((prev) => ({ ...prev, [path]: true }))
    const state = dirs[path]
    if (state === undefined || (state.entries === null && !state.loading)) void loadDir(path)
  }

  const renderDir = (path: string, depth: number): ReactNode => {
    const state = dirs[path]
    if (state === undefined) return null
    const indent = { paddingLeft: `${8 + depth * 14}px` }
    if (state.loading && state.entries === null) {
      return (
        <li className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground" style={indent}>
          <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
          {t('miniapp.file.loading')}
        </li>
      )
    }
    if (state.error !== null) {
      return (
        <li className="py-1 pr-2 text-[11px] text-red-700" style={indent}>
          {t('miniapp.file.treeError', { error: state.error })}
        </li>
      )
    }
    const entries = state.entries ?? []
    if (entries.length === 0) {
      return (
        <li className="py-1 text-[11px] text-muted-foreground" style={indent}>
          {t('miniapp.file.empty')}
        </li>
      )
    }
    return entries.map((entry) =>
      entry.type === 'dir' ? (
        <li key={entry.path}>
          <button
            type="button"
            aria-expanded={expanded[entry.path] === true}
            onClick={() => toggleDir(entry.path)}
            className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[11.5px] text-foreground transition-colors hover:bg-sidebar focus-visible:bg-accent-soft focus-visible:outline-none"
            style={indent}
          >
            {expanded[entry.path] === true ? (
              <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <Folder aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono">{entry.name}</span>
          </button>
          {expanded[entry.path] === true ? (
            <ul>{renderDir(entry.path, depth + 1)}</ul>
          ) : null}
        </li>
      ) : (
        <li key={entry.path}>
          <button
            type="button"
            data-miniapp-file={entry.path}
            onClick={() => onOpenFile(entry.path)}
            className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[11.5px] text-muted-foreground transition-colors hover:bg-sidebar hover:text-foreground focus-visible:bg-accent-soft focus-visible:text-foreground focus-visible:outline-none"
            style={indent}
          >
            <File aria-hidden="true" className="ml-4 h-3 w-3 shrink-0" />
            <span className="truncate font-mono">{entry.name}</span>
            {entry.size > 0 ? (
              <span className="ml-auto shrink-0 pl-2 font-mono text-[10px] tabular-nums text-muted-foreground/70">
                {formatBytes(entry.size)}
              </span>
            ) : null}
          </button>
        </li>
      )
    )
  }

  return (
    <div
      data-testid="miniapp-file-tree"
      className={cn(
        'flex h-full w-full min-h-0 flex-col overflow-hidden rounded-md border border-border bg-background'
      )}
    >
      <div className="shrink-0 border-b border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {t('miniapp.file.root')}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1 [scrollbar-gutter:stable]">
        {renderDir('', 0)}
      </ul>
    </div>
  )
}
