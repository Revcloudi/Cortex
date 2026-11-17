import { useState, type ReactNode } from 'react'
import { KeyRound, Network, Route, Server, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import type { InternalGraphData } from '@shared/types'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useI18n } from '@renderer/i18n'
import {
  deleteInternalEntity,
  type InternalEntityKind
} from '@renderer/lib/internalAdminApi'
import { DeleteInternalEntityDialog } from './DeleteInternalEntityDialog'

interface InternalEntityAdminProps {
  graph: InternalGraphData | null
  loading: boolean
  error: string | null
  readOnly: boolean
  onRetry: () => void
  onDeleted: () => void
}

interface DeleteTarget {
  kind: InternalEntityKind
  kindLabel: string
  id: string
  label: string
}

/**
 * Explicit cleanup surface for internal-scope entities.
 *
 * USB/SSH Android/iOS test devices belong to the client-findings domain, not to
 * internal operations; if an older session registered one here, this section is
 * the place to remove it. Deletes are one row at a time and rely on SQLite FK
 * cascades for dependent services/hops/trials.
 */
export function InternalEntityAdmin({
  graph,
  loading,
  error,
  readOnly,
  onRetry,
  onDeleted
}: InternalEntityAdminProps) {
  const { t } = useI18n()
  const [target, setTarget] = useState<DeleteTarget | null>(null)
  const [pending, setPending] = useState(false)

  const counts = {
    hosts: graph?.hosts.length ?? 0,
    services: graph?.services.length ?? 0,
    footholds: graph?.footholds.length ?? 0,
    credentials: graph?.credentials.length ?? 0,
    pivots: graph?.pivots.length ?? 0
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)

  const ask = (next: DeleteTarget): void => {
    if (readOnly) return
    setTarget(next)
  }

  const confirm = async (): Promise<void> => {
    if (target === null || pending) return
    setPending(true)
    try {
      await deleteInternalEntity(target.kind, target.id)
      toast.success(t('internal.delete.deleted', { label: target.label }))
      setTarget(null)
      onDeleted()
    } catch (cause) {
      toast.error(
        t('internal.delete.failed', {
          error: cause instanceof Error ? cause.message : String(cause)
        })
      )
    } finally {
      setPending(false)
    }
  }

  const sectionHeader = (icon: ReactNode, title: string, count: number) => (
    <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-2.5 text-[11.5px] font-medium text-foreground marker:content-none">
      {icon}
      <span>{title}</span>
      <span className="rounded-full border border-border bg-background px-1.5 font-mono text-[9.5px] tabular-nums text-muted-foreground">
        {count}
      </span>
    </summary>
  )

  const row = (
    kind: InternalEntityKind,
    kindLabel: string,
    id: string,
    label: string,
    detail: string
  ) => (
    <li
      key={`${kind}:${id}`}
      data-testid="internal-entity-row"
      data-kind={kind}
      data-id={id}
      className="flex min-w-0 items-center gap-2 border-t border-border/70 px-4 py-1.5 first:border-t-0"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[11.5px] text-foreground" title={label}>
          {label}
        </span>
        {detail ? (
          <span className="block truncate text-[10px] text-muted-foreground" title={detail}>
            {detail}
          </span>
        ) : null}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid={`internal-delete-${kind}`}
        aria-label={t('internal.delete.action', { label })}
        title={t('internal.delete.action', { label })}
        disabled={readOnly || pending}
        onClick={() => ask({ kind, kindLabel, id, label })}
      >
        <Trash2 aria-hidden="true" className="h-3.5 w-3.5 text-red-600" />
      </Button>
    </li>
  )

  return (
    <section
      data-testid="internal-entities"
      className="rounded-[10px] border border-border bg-background"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Users aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
          <h2 className="text-[12px] font-medium text-foreground">{t('internal.delete.panelTitle')}</h2>
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{total}</span>
        </div>
        <Button variant="ghost" size="xs" onClick={onRetry} className="text-[11px]">
          {t('common.refresh')}
        </Button>
      </div>
      <p className="px-4 pt-2 text-[10.5px] leading-relaxed text-muted-foreground">
        {t('internal.delete.panelHint')}
      </p>

      {readOnly ? (
        <p className="m-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          {t('internal.delete.readOnly')}
        </p>
      ) : null}

      {loading && graph === null ? (
        <div className="space-y-2 p-4" aria-hidden="true">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : error !== null && graph === null ? (
        <p className="p-4 text-[11.5px] text-red-700">{error}</p>
      ) : total === 0 ? (
        <p className="p-4 text-[11.5px] text-muted-foreground">{t('internal.delete.empty')}</p>
      ) : (
        <div className="mt-2 divide-y divide-border">
          {counts.hosts > 0 ? (
            <details open className="group">
              {sectionHeader(<Network aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />, t('internal.delete.hosts'), counts.hosts)}
              <ul>
                {graph?.hosts.map((host) =>
                  row('hosts', t('internal.delete.hosts'), host.id, `${host.ip}${host.hostname ? ` · ${host.hostname}` : ''}`, host.os || host.source)
                )}
              </ul>
            </details>
          ) : null}
          {counts.services > 0 ? (
            <details open>
              {sectionHeader(<Server aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />, t('internal.delete.services'), counts.services)}
              <ul>
                {graph?.services.map((service) =>
                  row(
                    'services',
                    t('internal.delete.services'),
                    service.id,
                    `${service.host_ip || service.host_id}:${service.port} · ${service.service || service.protocol || 'service'}`,
                    service.banner || service.source
                  )
                )}
              </ul>
            </details>
          ) : null}
          {counts.footholds > 0 ? (
            <details open>
              {sectionHeader(<Route aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />, t('internal.delete.footholds'), counts.footholds)}
              <ul>
                {graph?.footholds.map((foothold) =>
                  row(
                    'footholds',
                    t('internal.delete.footholds'),
                    foothold.id,
                    foothold.entry_host_port || foothold.id,
                    `${foothold.access_type} · ${foothold.privilege_level} · ${foothold.status}`
                  )
                )}
              </ul>
            </details>
          ) : null}
          {counts.credentials > 0 ? (
            <details open>
              {sectionHeader(<KeyRound aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />, t('internal.delete.credentials'), counts.credentials)}
              <ul>
                {graph?.credentials.map((credential) =>
                  row(
                    'credentials',
                    t('internal.delete.credentials'),
                    credential.id,
                    `${credential.username || '(no user)'}${credential.domain ? `@${credential.domain}` : ''} · ${credential.type}`,
                    credential.secret || credential.source
                  )
                )}
              </ul>
            </details>
          ) : null}
          {counts.pivots > 0 ? (
            <details open>
              {sectionHeader(<Route aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />, t('internal.delete.pivots'), counts.pivots)}
              <ul>
                {graph?.pivots.map((pivot) =>
                  row(
                    'pivots',
                    t('internal.delete.pivots'),
                    pivot.id,
                    `${pivot.tool || pivot.kind} · ${pivot.local_host}:${pivot.local_port}`,
                    pivot.local_protocol || pivot.status
                  )
                )}
              </ul>
            </details>
          ) : null}
        </div>
      )}

      <DeleteInternalEntityDialog
        open={target !== null}
        label={target?.label ?? ''}
        kind={target?.kindLabel ?? ''}
        pending={pending}
        onOpenChange={(open) => {
          if (!open && !pending) setTarget(null)
        }}
        onConfirm={() => void confirm()}
      />
    </section>
  )
}
