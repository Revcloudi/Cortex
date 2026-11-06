import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerDownRight,
  Loader2,
  RotateCcw,
  Trash2,
  Unplug
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  SnapshotSession,
  SnapshotSummary,
  SnapshotTestedInterface
} from '@shared/types'
import {
  Sheet,
  SheetCloseButton,
  SheetContent,
  SheetDescription,
  SheetTitle
} from '@renderer/components/ui/sheet'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { CopyButton } from '@renderer/components/common/CopyButton'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { MarkdownText } from '@renderer/components/common/MarkdownText'
import { useCopy } from '@renderer/hooks/useCopy'
import { useI18n } from '@renderer/i18n'
import { apiUnavailableMessage, getApi, toErrorMessage } from '@renderer/lib/api'
import { formatDateTime, formatDateTimeFull } from '@renderer/lib/format'
import { buildSnapshotBrief } from '@renderer/lib/snapshots'
import { cn } from '@renderer/lib/utils'
import { DeleteSnapshotDialog } from './DeleteSnapshotDialog'

interface SnapshotDetailProps {
  sessionId: string | null
  onClose: () => void
  /** Called after archive / rollback / delete so the list page can refetch. */
  onChanged: () => void
  /** Open a stored vulnerability (referenced by related_vuln_ids) on top. */
  onOpenVuln?: (vulnId: string) => void
}

/** Confirming a rollback requires a second click within this window. */
const RESTORE_CONFIRM_MS = 3000

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-foreground/70">{label}</dt>
      <dd className="mt-1 text-[12.5px] leading-relaxed text-foreground">{children}</dd>
    </div>
  )
}

function SectionHeading({ title, count }: { title: string; count?: number }) {
  return (
    <h3 className="flex items-center gap-2 text-[11px] font-medium text-foreground/70">
      {title}
      {count !== undefined ? (
        <span className="font-mono text-[11px] tabular-nums text-foreground/50">{count}</span>
      ) : null}
    </h3>
  )
}

/** Muted marker shared by table rows and the detail header. */
function ArchivedBadge({ className }: { className?: string }) {
  const { t } = useI18n()
  return (
    <span
      className={cn(
        'inline-flex h-[19px] shrink-0 items-center rounded-full border border-border bg-muted px-1.5 text-[10.5px] font-medium text-muted-foreground',
        className
      )}
    >
      {t('snapshot.badge.archived')}
    </span>
  )
}

/** Unfinished tasks / failed paths: full text, no truncation, no horizontal scroll. */
function TaskList({ items, tone }: { items: string[]; tone: 'amber' | 'red' }) {
  const { t } = useI18n()
  if (items.length === 0) {
    return <p className="text-[12.5px] text-muted-foreground">{t('common.none')}</p>
  }

  const styles =
    tone === 'amber'
      ? { box: 'border-amber-200 bg-amber-50 text-amber-800', dot: 'bg-amber-500' }
      : { box: 'border-red-200 bg-red-50 text-red-700', dot: 'bg-red-500' }

  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li
          key={index}
          className={cn(
            'flex items-start gap-2 rounded-md border px-3 py-2 text-[12.5px] leading-relaxed',
            styles.box
          )}
        >
          <span
            aria-hidden="true"
            className={cn('mt-[7px] h-1 w-1 shrink-0 rounded-full', styles.dot)}
          />
          <span className="min-w-0 whitespace-pre-wrap break-all">{item}</span>
        </li>
      ))}
    </ul>
  )
}

function HostChipList({ hosts }: { hosts: string[] }) {
  const { t } = useI18n()
  if (hosts.length === 0) {
    return (
      <p className="text-[12.5px] text-muted-foreground">{t('snapshot.value.notRecorded')}</p>
    )
  }

  return (
    <ul className="flex flex-wrap gap-1.5">
      {hosts.map((host) => (
        <li
          key={host}
          className="max-w-full break-all rounded border border-border bg-sidebar px-2 py-1 font-mono text-[12.5px] leading-relaxed text-foreground/80"
        >
          {host}
        </li>
      ))}
    </ul>
  )
}

/** Interface test matrix: target + attempted technique/payload, then the result. */
function TestedInterfaceList({ items }: { items: SnapshotTestedInterface[] }) {
  const { t } = useI18n()
  if (items.length === 0) {
    return <p className="text-[12.5px] text-muted-foreground">{t('snapshot.value.none')}</p>
  }

  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li
          key={index}
          data-testid="snapshot-tested-interface"
          className="rounded-md border border-border bg-background px-3 py-2.5"
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {item.method.trim().length > 0 ? (
              <span className="min-w-0 break-all font-mono text-[11.5px] leading-relaxed text-foreground/60">
                {item.method}
              </span>
            ) : null}
            <code className="min-w-0 break-all font-mono text-[12.5px] leading-relaxed text-foreground">
              {item.target}
            </code>
          </div>
          <p
            className={cn(
              'mt-1.5 flex items-start gap-1.5 text-[12px] leading-relaxed',
              item.result.trim().length > 0 ? 'text-foreground/80' : 'text-muted-foreground'
            )}
          >
            <CornerDownRight
              aria-hidden="true"
              className="mt-[3px] h-3 w-3 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 whitespace-pre-wrap break-all">
              {item.result.trim().length > 0
                ? item.result
                : t('snapshot.value.notRecordedResult')}
            </span>
          </p>
        </li>
      ))}
    </ul>
  )
}

/** Stored vulnerability references; each chip opens the existing vulnerability sheet. */
function RelatedVulnChips({
  ids,
  onOpen
}: {
  ids: string[]
  onOpen?: (vulnId: string) => void
}) {
  const { t } = useI18n()
  if (ids.length === 0) {
    return <p className="text-[12.5px] text-muted-foreground">{t('snapshot.value.none')}</p>
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          data-testid="snapshot-related-vuln"
          aria-label={t('snapshot.detail.vulnOpenAria', { id })}
          onClick={() => onOpen?.(id)}
          className="inline-flex max-w-full items-center rounded-full border border-border bg-background px-2.5 py-1 font-mono text-[11.5px] leading-relaxed text-foreground/80 transition-colors duration-150 hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="min-w-0 break-all">{id}</span>
        </button>
      ))}
    </div>
  )
}

/** Direct child sessions of a project session; clicking one swaps the sheet view. */
function ChildSessionList({
  items,
  loading,
  onOpen
}: {
  items: SnapshotSummary[] | null
  loading: boolean
  onOpen: (sessionId: string) => void
}) {
  const { t } = useI18n()
  if (loading && items === null) {
    return (
      <div className="space-y-1.5">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }

  if (items === null || items.length === 0) {
    return <p className="text-[12.5px] text-muted-foreground">{t('snapshot.value.none')}</p>
  }

  return (
    <ul className="overflow-hidden rounded-[10px] border border-border">
      {items.map((child) => (
        <li key={child.session_id} className="border-b border-border last:border-b-0">
          <button
            type="button"
            data-testid="snapshot-child-session"
            data-session-id={child.session_id}
            aria-label={t('snapshot.detail.childOpenAria', {
              project: child.project_name,
              id: child.session_id
            })}
            onClick={() => onOpen(child.session_id)}
            className="group flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-sidebar focus-visible:bg-accent-soft focus-visible:outline-none"
          >
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="truncate text-[12.5px] font-medium text-foreground group-hover:text-accent">
                  {child.project_name}
                </span>
                {child.archived_at !== null ? <ArchivedBadge /> : null}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
                <span className="min-w-0 truncate">
                  {child.current_phase.trim().length > 0
                    ? child.current_phase
                    : t('snapshot.value.notRecorded')}
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {t('snapshot.detail.childStats', {
                    unfinished: child.unfinished_count,
                    failed: child.failed_count
                  })}
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {t('snapshot.detail.childUpdated', {
                    date: formatDateTime(child.updated_at)
                  })}
                </span>
              </span>
            </span>
            <ChevronRight
              aria-hidden="true"
              className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity duration-150 group-hover:opacity-100"
            />
          </button>
        </li>
      ))}
    </ul>
  )
}

function SheetSkeleton() {
  return (
    <div aria-hidden="true" className="px-6 py-5">
      <Skeleton className="h-[22px] w-[46%]" />
      <Skeleton className="mt-2 h-3.5 w-[30%]" />
      <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4">
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-3.5 w-16" />
        <Skeleton className="h-3.5 w-24" />
      </div>
      <Skeleton className="mt-6 h-16 w-full" />
      <Skeleton className="mt-4 h-12 w-full" />
      <Skeleton className="mt-4 h-20 w-full" />
    </div>
  )
}

/**
 * Cognitive snapshot inspector: fetches one session on open and shows the full
 * tactical state with amber / red / emerald semantics, a one-click Markdown
 * brief, project → child-session navigation, archive toggle, delete, and a
 * two-step rollback of the previous overwrite.
 */
export function SnapshotDetail({
  sessionId,
  onClose,
  onChanged,
  onOpenVuln
}: SnapshotDetailProps) {
  const { t } = useI18n()
  /** The session currently shown; child/parent navigation swaps it inside the same sheet. */
  const [viewSessionId, setViewSessionId] = useState<string | null>(sessionId)
  const [session, setSession] = useState<SnapshotSession | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notFoundId, setNotFoundId] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [children, setChildren] = useState<SnapshotSummary[] | null>(null)
  const [childrenLoading, setChildrenLoading] = useState(false)
  const [parentSession, setParentSession] = useState<SnapshotSession | null>(null)
  const [confirmingRestore, setConfirmingRestore] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const confirmTimer = useRef<number | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { copied, copy } = useCopy()

  useEffect(() => {
    setViewSessionId(sessionId)
  }, [sessionId])

  useEffect(() => {
    return () => window.clearTimeout(confirmTimer.current)
  }, [])

  useEffect(() => {
    window.clearTimeout(confirmTimer.current)
    setConfirmingRestore(false)
    setRestoring(false)
    setArchiving(false)
    setDeleteOpen(false)
    setChildren(null)
    setChildrenLoading(false)
    setParentSession(null)
    scrollRef.current?.scrollTo({ top: 0 })
  }, [viewSessionId])

  useEffect(() => {
    if (!viewSessionId) return
    const api = getApi()
    if (!api) {
      setError(apiUnavailableMessage(t))
      setLoading(false)
      return
    }

    let alive = true
    setLoading(true)
    setError(null)
    setNotFoundId(null)
    setSession(null)

    api
      .getSnapshot(viewSessionId)
      .then(
        (next) => {
          if (!alive) return
          if (next === null) {
            setSession(null)
            setNotFoundId(viewSessionId)
          } else {
            setSession(next)
            setError(null)
            setNotFoundId(null)
          }
        },
        (cause: unknown) => {
          if (alive) {
            setError(toErrorMessage(cause, t))
            setNotFoundId(null)
          }
        }
      )
      .finally(() => {
        if (alive) setLoading(false)
      })

    return () => {
      alive = false
    }
  }, [viewSessionId, retryKey, t])

  useEffect(() => {
    if (!session) return
    if (session.child_count <= 0) {
      setChildren(null)
      setChildrenLoading(false)
      return
    }
    const api = getApi()
    if (!api) return

    let alive = true
    setChildrenLoading(true)
    api
      .listSnapshots({ parentSessionId: session.session_id, includeArchived: true })
      .then(
        (result) => {
          if (alive) setChildren(result.items)
        },
        () => {
          if (alive) setChildren([])
        }
      )
      .finally(() => {
        if (alive) setChildrenLoading(false)
      })

    return () => {
      alive = false
    }
  }, [session?.session_id, session?.child_count, session?.updated_at])

  useEffect(() => {
    const parentId = session?.parent_session_id ?? null
    if (!parentId) {
      setParentSession(null)
      return
    }
    const api = getApi()
    if (!api) return

    let alive = true
    api.getSnapshot(parentId).then(
      (next) => {
        if (alive) setParentSession(next)
      },
      () => {
        if (alive) setParentSession(null)
      }
    )

    return () => {
      alive = false
    }
  }, [session?.parent_session_id])

  const isArchived = session?.archived_at != null

  const gotoSession = (nextId: string) => {
    if (nextId === viewSessionId) return
    setViewSessionId(nextId)
  }

  const handleCopyBrief = () => {
    if (!session) return
    const options = session.parent_session_id
      ? { parentName: parentSession?.project_name }
      : { children: children ?? undefined }
    void copy(
      buildSnapshotBrief(session, { ...options, t }),
      t('snapshot.detail.copiedBrief')
    )
  }

  const handleRestore = async () => {
    if (!session || restoring || session.archived_at !== null) return

    if (!confirmingRestore) {
      setConfirmingRestore(true)
      window.clearTimeout(confirmTimer.current)
      confirmTimer.current = window.setTimeout(
        () => setConfirmingRestore(false),
        RESTORE_CONFIRM_MS
      )
      return
    }

    window.clearTimeout(confirmTimer.current)
    setConfirmingRestore(false)

    const api = getApi()
    if (!api) {
      toast.error(apiUnavailableMessage(t))
      return
    }

    setRestoring(true)
    try {
      const restored = await api.restoreSnapshotPrevious(session.session_id)
      setSession(restored)
      toast(t('snapshot.detail.restored'))
      onChanged()
    } catch (cause) {
      toast.error(toErrorMessage(cause, t))
    } finally {
      setRestoring(false)
    }
  }

  const handleArchive = async () => {
    if (!session || archiving) return
    const api = getApi()
    if (!api) {
      toast.error(apiUnavailableMessage(t))
      return
    }

    const nextArchived = session.archived_at === null
    setArchiving(true)
    try {
      const updated = await api.archiveSnapshot(session.session_id, nextArchived)
      setSession(updated)
      toast(
        nextArchived ? t('snapshot.detail.archived') : t('snapshot.detail.unarchived')
      )
      onChanged()
    } catch (cause) {
      toast.error(toErrorMessage(cause, t))
    } finally {
      setArchiving(false)
    }
  }

  const handleDeleted = () => {
    setDeleteOpen(false)
    onChanged()
    onClose()
  }

  const testedInterfaces = session?.tested_interfaces ?? []
  const relatedVulnIds = session?.related_vuln_ids ?? []
  const notes = session?.notes ?? ''
  const loadError =
    error ??
    (notFoundId !== null ? t('snapshot.detail.notFound', { id: notFoundId }) : null)

  return (
    <>
      <Sheet
        open={sessionId !== null}
        onOpenChange={(next) => {
          if (!next) onClose()
        }}
      >
        <SheetContent data-testid="snapshot-sheet">
          <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-6">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              COGNITIVE SNAPSHOT
            </span>
            <SheetCloseButton />
          </div>

          {loading && session === null ? (
            <SheetSkeleton />
          ) : loadError !== null && session === null ? (
            <EmptyState
              icon={Unplug}
              title={t('snapshot.detail.loadErrorTitle')}
              description={loadError}
              className="my-auto"
            >
              <Button variant="outline" size="sm" onClick={() => setRetryKey((value) => value + 1)}>
                {t('common.retry')}
              </Button>
            </EmptyState>
          ) : session !== null ? (
            <div
              ref={scrollRef}
              className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
            >
              {session.parent_session_id !== null ? (
                <div className="border-b border-border bg-sidebar px-6 py-2">
                  <button
                    type="button"
                    data-testid="snapshot-parent"
                    disabled={parentSession === null}
                    onClick={() => {
                      if (parentSession) gotoSession(parentSession.session_id)
                    }}
                    className="inline-flex max-w-full items-center gap-1.5 text-[11.5px] transition-colors duration-150 hover:text-accent focus-visible:text-accent focus-visible:outline-none disabled:opacity-60"
                  >
                    <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    <span className="shrink-0 text-muted-foreground">
                      {t('snapshot.detail.parentProject')}
                    </span>
                    <span className="min-w-0 break-all font-mono font-medium text-foreground">
                      {parentSession?.project_name ?? t('common.loading')}
                    </span>
                  </button>
                </div>
              ) : null}

              <div className="border-b border-border px-6 pb-5 pt-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <SheetTitle className="break-all text-[21px] font-medium tracking-tight">
                        {session.project_name}
                      </SheetTitle>
                      {isArchived ? <ArchivedBadge /> : null}
                    </div>
                    <SheetDescription className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-foreground/70">
                      <span>{t('snapshot.detail.sessionLabel')}</span>
                      <code className="break-all font-mono text-[12.5px] text-foreground/80">
                        {session.session_id}
                      </code>
                      <CopyButton
                        value={session.session_id}
                        label={t('snapshot.detail.copySessionId')}
                        toastMessage={t('snapshot.detail.copiedSessionId')}
                      />
                    </SheetDescription>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      data-testid="snapshot-copy-brief"
                      variant="outline"
                      size="sm"
                      onClick={handleCopyBrief}
                    >
                      {copied ? (
                        <Check aria-hidden="true" className="h-3.5 w-3.5 text-emerald-600" />
                      ) : (
                        <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                      )}
                      {t('snapshot.detail.copyBrief')}
                    </Button>

                    {session.has_previous_state && !isArchived ? (
                      <Button
                        data-testid="snapshot-restore"
                        variant="outline"
                        size="sm"
                        title={
                          confirmingRestore
                            ? t('snapshot.detail.restoreConfirmTitle')
                            : t('snapshot.detail.restoreTitle')
                        }
                        disabled={restoring}
                        onClick={() => void handleRestore()}
                        className={cn(
                          confirmingRestore &&
                            'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 hover:text-amber-900'
                        )}
                      >
                        {restoring ? (
                          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                        )}
                        {confirmingRestore
                          ? t('snapshot.detail.restoreConfirm')
                          : t('snapshot.detail.restore')}
                      </Button>
                    ) : null}

                    <Button
                      data-testid="snapshot-archive"
                      variant="outline"
                      size="sm"
                      title={
                        isArchived
                          ? t('snapshot.detail.unarchiveTitle')
                          : t('snapshot.detail.archiveTitle')
                      }
                      disabled={archiving}
                      onClick={() => void handleArchive()}
                    >
                      {archiving ? (
                        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                      ) : isArchived ? (
                        <ArchiveRestore aria-hidden="true" className="h-3.5 w-3.5" />
                      ) : (
                        <Archive aria-hidden="true" className="h-3.5 w-3.5" />
                      )}
                      {isArchived
                        ? t('snapshot.detail.unarchive')
                        : t('snapshot.detail.archive')}
                    </Button>

                    <Button
                      data-testid="snapshot-delete"
                      variant="outline"
                      size="sm"
                      onClick={() => setDeleteOpen(true)}
                      className="text-red-600 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                      {t('common.delete')}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="space-y-6 px-6 py-5">
                <section>
                  <SectionHeading title={t('snapshot.detail.overview')} />
                  <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                    <MetaItem label={t('snapshot.table.phase')}>
                      {session.current_phase.trim().length > 0 ? (
                        <span className="break-all">{session.current_phase}</span>
                      ) : (
                        <span className="text-muted-foreground">
                          {t('snapshot.value.notRecorded')}
                        </span>
                      )}
                    </MetaItem>
                    <MetaItem label={t('snapshot.table.updatedAt')}>
                      <span className="font-mono tabular-nums">
                        {formatDateTimeFull(session.updated_at)}
                      </span>
                    </MetaItem>
                    <MetaItem label={t('snapshot.detail.createdAt')}>
                      <span className="font-mono tabular-nums">
                        {formatDateTimeFull(session.created_at)}
                      </span>
                    </MetaItem>
                    <MetaItem label={t('snapshot.detail.sessionId')}>
                      <span className="flex items-start gap-1.5">
                        <code className="break-all font-mono text-[12.5px] text-foreground/80">
                          {session.session_id}
                        </code>
                        <CopyButton
                          value={session.session_id}
                          label={t('snapshot.detail.copySessionId')}
                          toastMessage={t('snapshot.detail.copiedSessionId')}
                          className="mt-0.5"
                        />
                      </span>
                    </MetaItem>
                  </dl>
                </section>

                {session.child_count > 0 ? (
                  <section>
                    <SectionHeading
                      title={t('snapshot.detail.childSessions')}
                      count={children?.length ?? session.child_count}
                    />
                    <div className="mt-3">
                      <ChildSessionList
                        items={children}
                        loading={childrenLoading}
                        onOpen={gotoSession}
                      />
                    </div>
                  </section>
                ) : null}

                <section>
                  <SectionHeading
                    title={t('snapshot.detail.targetAssets')}
                    count={session.target_hosts.length}
                  />
                  <div className="mt-3">
                    <HostChipList hosts={session.target_hosts} />
                  </div>
                </section>

                <section>
                  <SectionHeading
                    title={t('snapshot.detail.unfinishedTasks')}
                    count={session.unfinished_tasks.length}
                  />
                  <div className="mt-3">
                    <TaskList items={session.unfinished_tasks} tone="amber" />
                  </div>
                </section>

                <section>
                  <SectionHeading
                    title={t('snapshot.detail.failedPaths')}
                    count={session.failed_paths.length}
                  />
                  <div className="mt-3">
                    <TaskList items={session.failed_paths} tone="red" />
                  </div>
                </section>

                <section>
                  <SectionHeading
                    title={t('snapshot.detail.testedInterfaces')}
                    count={testedInterfaces.length}
                  />
                  <div className="mt-3">
                    <TestedInterfaceList items={testedInterfaces} />
                  </div>
                </section>

                <section>
                  <SectionHeading title={t('snapshot.detail.notes')} />
                  <div className="mt-3 rounded-[10px] border border-border bg-background px-4 py-3">
                    {notes.trim().length > 0 ? (
                      <MarkdownText content={notes} className="[overflow-wrap:anywhere]" />
                    ) : (
                      <p className="text-[12.5px] text-muted-foreground">
                        {t('snapshot.value.none')}
                      </p>
                    )}
                  </div>
                </section>

                <section>
                  <SectionHeading
                    title={t('snapshot.detail.relatedVulns')}
                    count={relatedVulnIds.length}
                  />
                  <div className="mt-3">
                    <RelatedVulnChips ids={relatedVulnIds} onOpen={onOpenVuln} />
                  </div>
                </section>

                <section>
                  <SectionHeading title={t('snapshot.detail.nextSteps')} />
                  <div className="mt-3 rounded-[10px] border border-emerald-200/70 bg-emerald-50/70 px-4 py-3">
                    {session.next_steps.trim().length > 0 ? (
                      <p className="whitespace-pre-wrap break-all text-[12.5px] leading-relaxed text-emerald-700">
                        {session.next_steps}
                      </p>
                    ) : (
                      <p className="text-[12.5px] text-muted-foreground">
                        {t('snapshot.value.notRecorded')}
                      </p>
                    )}
                  </div>
                </section>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <DeleteSnapshotDialog
        open={deleteOpen}
        session={session}
        onOpenChange={setDeleteOpen}
        onDeleted={handleDeleted}
      />
    </>
  )
}
