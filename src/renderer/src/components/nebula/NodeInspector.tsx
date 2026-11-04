import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Copy,
  ExternalLink,
  X
} from 'lucide-react'
import type {
  FootholdNode,
  GraphNeighbor,
  HostNode,
  InternalHostNode,
  InternalServiceNode,
  LeakNode,
  NebulaNode,
  ProjectNode,
  SnapshotNode,
  TargetNode,
  VulnNode
} from '@shared/graph'
import {
  HudButton,
  HudPanelHeader,
  HudSectionTitle
} from '@renderer/components/nebula/HudChrome'
import { useCopy } from '@renderer/hooks/useCopy'
import { useI18n } from '@renderer/i18n'
import type { Translate } from '@renderer/lib/api'
import { formatDateTimeFull, formatVulnType } from '@renderer/lib/format'
import {
  FOOTHOLD_STATUS_COLORS,
  INTERNAL_HOST_STATE_COLORS,
  NEBULA_UI,
  NODE_TYPE_COLORS,
  SERVICE_STATE_COLORS,
  SEVERITY_BADGE_CLASSES,
  SEVERITY_NODE_COLORS,
  STATUS_BADGE_CLASSES,
  nodeColor,
  rgba
} from '@renderer/lib/graphTheme'
import { cn } from '@renderer/lib/utils'

export interface NodeInspectorProps {
  /** Never null: the page mounts the inspector only when a node is selected. */
  node: NebulaNode
  /** Both link directions touching `node` in the *visible* graph. */
  neighbors: GraphNeighbor[]
  onClose: () => void
  /** Click a related node chip → select it (page re-renders inspector). */
  onSelectNode: (nodeId: string) => void
  /**
   * Label for the "view full details" button (vuln / asset / snapshot only).
   * The drawer is intentionally summary-only; long evidence lives on the page.
   */
  detailLabel: string | null
  onOpenDetail: () => void
  className?: string
}

/** Preview limits: the drawer never renders full evidence / inventories. */
const LEAK_PREVIEW_CHARS = 32
const TEXT_PREVIEW_CHARS = 90
const RELATION_LIMIT = 6
const CHIP_LIMIT = 4

function preview(value: string, maxChars = TEXT_PREVIEW_CHARS): string {
  const trimmed = value.trim()
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`
}

/* ------------------------------------------------------------------ atoms -- */

interface RowSpec {
  key: string
  label: string
  value: ReactNode
  /** Tabular mono alignment for ids, hosts, URLs and counters. */
  mono?: boolean
}

interface NodeSections {
  identity: RowSpec[]
  metrics: RowSpec[]
  /** Optional stand-alone HUD note (currently the `+N` aggregation hint). */
  note?: ReactNode
}

/** HUD chip used for types, severities and statuses (colours come from graphTheme). */
function Badge({
  className,
  style,
  children
}: {
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  return (
    <span
      className={cn(NEBULA_UI.chip, 'max-w-full whitespace-normal break-words', className)}
      style={style}
    >
      {children}
    </span>
  )
}

/** 1.5px glowing node-colour dot shared by type chips and relation rows. */
function ColorDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: color, boxShadow: `0 0 6px ${rgba(color, 0.7)}` }}
    />
  )
}

/** Type chip: vulns inherit their severity colour, other types their node hue. */
function TypeChip({ node }: { node: NebulaNode }) {
  const { t } = useI18n()
  if (node.type === 'vuln') {
    return (
      <Badge className={cn('shrink-0', SEVERITY_BADGE_CLASSES[node.severity])}>
        <ColorDot color={SEVERITY_NODE_COLORS[node.severity]} />
        {t('nebula.type.vuln')}
      </Badge>
    )
  }
  const color = NODE_TYPE_COLORS[node.type]
  return (
    <Badge
      className="shrink-0"
      style={{
        borderColor: rgba(color, 0.35),
        backgroundColor: rgba(color, 0.12),
        color: rgba(color, 0.92)
      }}
    >
      <ColorDot color={color} />
      {t(`nebula.type.${node.type}`)}
    </Badge>
  )
}

/**
 * Definition rows: micro uppercase label in a fixed column, value on the right,
 * hairline rule between rows. Mirrors the reference HUD's `LABEL: value` stats.
 */
function SummaryRows({ rows }: { rows: readonly RowSpec[] }) {
  return (
    <dl className="mt-1.5 divide-y divide-[#00E5FF]/[0.07]">
      {rows.map((row) => (
        <div
          key={row.key}
          className="grid min-w-0 grid-cols-[100px_minmax(0,1fr)] items-baseline gap-2 py-1.5"
        >
          <dt className={cn(NEBULA_UI.label, 'text-[11.5px] leading-[1.5]')}>{row.label}</dt>
          <dd
            className={cn(
              'min-w-0 break-words font-mono text-[12.5px] leading-[1.6] text-[#C7E9F5]',
              row.mono && 'tabular-nums'
            )}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Wrapping mono chips for id / host lists (bounded by CHIP_LIMIT). */
function ChipList({ values, mono = true }: { values: readonly string[]; mono?: boolean }) {
  const { t } = useI18n()
  if (values.length === 0) {
    return <span className="text-[#7FA9BE]">{t('nebula.field.none')}</span>
  }
  const shown = values.slice(0, CHIP_LIMIT)
  const rest = values.length - shown.length
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((value, index) => (
        <span
          key={`${value}-${index}`}
          className={cn(
            'inline-block max-w-full break-all rounded-[2px] border border-[#00E5FF]/20',
            'bg-[#00E5FF]/[0.05] px-1.5 py-0.5 text-[11px] leading-relaxed text-[#A9D6E5]',
            mono && 'font-mono'
          )}
        >
          {value}
        </span>
      ))}
      {rest > 0 ? (
        <span className="inline-block rounded-[2px] border border-[#00E5FF]/10 bg-[#00E5FF]/[0.03] px-1.5 py-0.5 font-mono text-[10.5px] text-[#7FA9BE]">
          +{rest}
        </span>
      ) : null}
    </span>
  )
}

/* -------------------------------------------------------------- summaries -- */

function HostSections(node: HostNode, t: Translate): NodeSections {
  const { data } = node
  return {
    identity: [
      {
        key: 'project',
        label: t('nebula.field.project'),
        value: data.project_name.trim().length > 0 ? data.project_name : t('nebula.field.none')
      },
      {
        key: 'status',
        label: t('nebula.field.status'),
        value: (
          <Badge className={cn('shrink-0', STATUS_BADGE_CLASSES[data.status])}>
            {t(`label.assetStatus.${data.status}`)}
          </Badge>
        )
      },
      {
        key: 'tech',
        label: t('nebula.field.techStack'),
        value:
          data.tech_stack.trim().length > 0
            ? preview(data.tech_stack, 72)
            : t('nebula.field.none')
      },
      { key: 'lastSeen', label: t('nebula.field.lastSeen'), value: formatDateTimeFull(data.last_seen) }
    ],
    metrics: [
      { key: 'interfaces', label: t('nebula.field.interfaces'), value: data.interface_count, mono: true },
      { key: 'leaks', label: t('nebula.field.leaks'), value: data.leaked_count, mono: true }
    ]
  }
}

function VulnSections(node: VulnNode, t: Translate): NodeSections {
  const { data } = node
  const identity: RowSpec[] = [
    { key: 'type', label: t('nebula.field.vulnType'), value: formatVulnType(data.vuln_type, t) },
    { key: 'host', label: t('nebula.field.host'), value: data.host, mono: true }
  ]
  if (data.service_host !== undefined && data.service_host.length > 0) {
    identity.push({
      key: 'serviceHost',
      label: t('nebula.field.serviceHost'),
      value: data.service_host,
      mono: true
    })
  }
  identity.push({
    key: 'targetUrl',
    label: t('nebula.field.targetUrl'),
    value: data.target_url,
    mono: true
  })

  const metrics: RowSpec[] = [
    {
      key: 'severity',
      label: t('nebula.field.severity'),
      value: (
        <Badge className={cn('shrink-0', SEVERITY_BADGE_CLASSES[node.severity])}>
          {t(`label.severity.${node.severity}`)}
        </Badge>
      )
    },
    {
      key: 'status',
      label: t('nebula.field.status'),
      value: (
        <Badge className={cn('shrink-0', STATUS_BADGE_CLASSES[node.status])}>
          {t(`label.status.${node.status}`)}
        </Badge>
      )
    }
  ]
  if (data.related_vuln_ids.length > 0) {
    metrics.push({
      key: 'related',
      label: t('nebula.field.relatedVulns'),
      value: t('nebula.inspector.relatedCount', { count: data.related_vuln_ids.length })
    })
  }
  return { identity, metrics }
}

/** Truncated, copyable leak value (secrets are never rendered in full). */
function LeakValue({ value }: { value: string }) {
  const { t } = useI18n()
  const { copied, copy } = useCopy()
  const truncated = value.length > LEAK_PREVIEW_CHARS
  const shown = truncated ? `${value.slice(0, LEAK_PREVIEW_CHARS)}…` : value
  return (
    <div className="min-w-0">
      <p className="break-all rounded-[2px] border border-[#00E5FF]/20 bg-[#01060D]/80 px-2 py-1.5 font-mono text-[12.5px] leading-relaxed text-[#C7E9F5]">
        {shown}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <HudButton
          size="sm"
          variant="ghost"
          onClick={() => void copy(value, t('nebula.inspector.copied'))}
        >
          {copied ? (
            <Check aria-hidden="true" className="h-3 w-3 text-[#10B981]" />
          ) : (
            <Copy aria-hidden="true" className="h-3 w-3" />
          )}
          {copied ? t('nebula.inspector.copied') : t('nebula.inspector.copy')}
        </HudButton>
        {truncated ? (
          <span className={cn(NEBULA_UI.chip, 'border-[#FFAA00]/30 bg-[#FFAA00]/[0.06] text-[#FFC766]')}>
            {t('nebula.inspector.truncated')}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function LeakSections(node: LeakNode, t: Translate): NodeSections {
  const { data } = node
  const color = NODE_TYPE_COLORS.leak
  return {
    identity: [
      {
        key: 'infoType',
        label: t('nebula.field.infoType'),
        value: (
          <Badge
            className="shrink-0"
            style={{
              borderColor: rgba(color, 0.35),
              backgroundColor: rgba(color, 0.12),
              color: rgba(color, 0.92)
            }}
          >
            {t(`ui.leakType.${data.info_type}`)}
          </Badge>
        )
      },
      { key: 'host', label: t('nebula.field.host'), value: data.host, mono: true },
      { key: 'value', label: t('nebula.field.value'), value: <LeakValue value={data.value} /> },
      { key: 'source', label: t('nebula.field.source'), value: preview(data.source, 80) },
      {
        key: 'impact',
        label: t('nebula.field.impact'),
        value: preview(data.potential_impact, 110)
      }
    ],
    metrics: []
  }
}

function SnapshotSections(node: SnapshotNode, t: Translate): NodeSections {
  const { data } = node
  return {
    identity: [
      { key: 'project', label: t('nebula.field.project'), value: data.project_name },
      {
        key: 'phase',
        label: t('nebula.field.phase'),
        value:
          data.current_phase.trim().length > 0
            ? preview(data.current_phase, 90)
            : t('nebula.field.none')
      },
      { key: 'session', label: t('nebula.field.session'), value: data.session_id, mono: true },
      { key: 'updatedAt', label: t('nebula.field.updatedAt'), value: formatDateTimeFull(data.updated_at) },
      {
        key: 'targetHosts',
        label: t('nebula.field.targetHosts'),
        value: <ChipList values={data.target_hosts} />
      }
    ],
    metrics: [
      {
        key: 'relatedVulns',
        label: t('nebula.field.relatedVulns'),
        value:
          data.related_vuln_ids.length > 0
            ? t('nebula.inspector.relatedCount', { count: data.related_vuln_ids.length })
            : t('nebula.field.none')
      }
    ]
  }
}

/** Compact summary for a collapsed `+N` node (large-graph aggregation). */
function AggregateSections(node: VulnNode | LeakNode, t: Translate): NodeSections {
  const aggregate = node.data.aggregate
  if (aggregate === undefined) return { identity: [], metrics: [] }
  const accent =
    aggregate.kind === 'vuln'
      ? SEVERITY_NODE_COLORS[aggregate.severity ?? 'Info']
      : NODE_TYPE_COLORS.leak
  return {
    identity: [
      { key: 'host', label: t('nebula.field.host'), value: node.data.host, mono: true },
      {
        key: 'samples',
        label: t('nebula.aggregate.samplesLabel'),
        value: <ChipList values={aggregate.samples} mono={false} />
      }
    ],
    metrics: [
      {
        key: 'count',
        label: t('nebula.aggregate.countLabel'),
        value: aggregate.count,
        mono: true
      },
      {
        key: 'severity',
        label: t('nebula.aggregate.severityLabel'),
        value:
          aggregate.severity !== undefined ? (
            <Badge className={cn('shrink-0', SEVERITY_BADGE_CLASSES[aggregate.severity])}>
              {t(`label.severity.${aggregate.severity}`)}
            </Badge>
          ) : (
            <Badge
              className="shrink-0"
              style={{
                borderColor: rgba(accent, 0.35),
                backgroundColor: rgba(accent, 0.12),
                color: rgba(accent, 0.92)
              }}
            >
              {t('nebula.type.leak')}
            </Badge>
          )
      }
    ],
    note: (
      <div className="mt-2.5 border-y border-r border-[#FFAA00]/15 border-l-2 border-l-[#FFAA00]/60 bg-[#FFAA00]/[0.05] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[#FFC766]">
        {t('nebula.aggregate.hint')}
      </div>
    )
  }
}

function ProjectSections(node: ProjectNode, t: Translate): NodeSections {
  return {
    identity: [
      { key: 'project', label: t('nebula.field.project'), value: node.data.project_name }
    ],
    metrics: [
      { key: 'assets', label: t('nebula.hud.statHosts'), value: node.data.asset_count, mono: true },
      { key: 'sessions', label: t('nebula.field.session'), value: node.data.session_count, mono: true }
    ]
  }
}

function TargetSections(node: TargetNode, t: Translate): NodeSections {
  return {
    identity: [
      { key: 'target', label: t('nebula.field.target'), value: node.data.target, mono: true },
      { key: 'project', label: t('nebula.field.project'), value: node.data.project_name },
      { key: 'hostKey', label: t('nebula.field.hostKey'), value: node.data.host_key, mono: true }
    ],
    metrics: [
      { key: 'assets', label: t('nebula.hud.statHosts'), value: node.data.asset_count, mono: true },
      { key: 'sessions', label: t('nebula.field.session'), value: node.data.session_count, mono: true }
    ]
  }
}

/** Tinted HUD chip for a status colour that is not a severity (internal states). */
function statusTint(color: string): CSSProperties {
  return {
    borderColor: rgba(color, 0.4),
    backgroundColor: rgba(color, 0.12),
    color: rgba(color, 0.95)
  }
}

/** Foothold bridge: identity + how/where the intranet was entered (plan §7.1). */
function FootholdSections(node: FootholdNode, t: Translate): NodeSections {
  const { data } = node
  const identity: RowSpec[] = [
    {
      key: 'project',
      label: t('nebula.field.project'),
      value: data.project_name.trim().length > 0 ? data.project_name : t('nebula.field.none')
    },
    {
      key: 'entryHost',
      label: t('nebula.field.entryHost'),
      value: data.entry_host_port,
      mono: true
    },
    {
      key: 'accessType',
      label: t('nebula.field.accessType'),
      value: (
        <Badge style={statusTint(NODE_TYPE_COLORS.foothold)}>
          {t(`nebula.accessType.${data.access_type}`)}
        </Badge>
      )
    },
    {
      key: 'privilege',
      label: t('nebula.field.privilege'),
      value: t(`nebula.privilege.${data.privilege_level}`)
    },
    {
      key: 'status',
      label: t('nebula.field.status'),
      value: (
        <Badge style={statusTint(FOOTHOLD_STATUS_COLORS[data.status])}>
          {t(`nebula.footholdStatus.${data.status}`)}
        </Badge>
      )
    },
    {
      key: 'establishedAt',
      label: t('nebula.field.establishedAt'),
      value:
        data.established_at.trim().length > 0
          ? formatDateTimeFull(data.established_at)
          : t('nebula.field.none')
    },
    {
      key: 'lastVerifiedAt',
      label: t('nebula.field.lastVerifiedAt'),
      value:
        data.last_verified_at.trim().length > 0
          ? formatDateTimeFull(data.last_verified_at)
          : t('nebula.field.none')
    },
    {
      key: 'evidence',
      label: t('nebula.field.evidence'),
      value:
        data.evidence.trim().length > 0 ? preview(data.evidence, 140) : t('nebula.field.none')
    }
  ]
  const metrics: RowSpec[] = [
    { key: 'reachedHosts', label: t('nebula.field.reachedHosts'), value: data.host_count, mono: true }
  ]
  if (data.entry_vuln_id.trim().length > 0) {
    metrics.push({
      key: 'entryVuln',
      label: t('nebula.field.entryVuln'),
      value: data.entry_vuln_id,
      mono: true
    })
  }
  return { identity, metrics }
}

/** Internal host: the intranet machine record (never a top-level Web asset). */
function InternalHostSections(node: InternalHostNode, t: Translate): NodeSections {
  const { data } = node
  return {
    identity: [
      { key: 'ip', label: t('nebula.field.ip'), value: data.ip, mono: true },
      {
        key: 'hostname',
        label: t('nebula.field.hostname'),
        value: data.hostname.trim().length > 0 ? data.hostname : t('nebula.field.none')
      },
      {
        key: 'project',
        label: t('nebula.field.project'),
        value: data.project_name.trim().length > 0 ? data.project_name : t('nebula.field.none')
      },
      {
        key: 'os',
        label: t('nebula.field.os'),
        value: data.os.trim().length > 0 ? data.os : t('nebula.field.none')
      },
      {
        key: 'subnet',
        label: t('nebula.field.subnet'),
        value: data.subnet.trim().length > 0 ? data.subnet : t('nebula.field.none'),
        mono: true
      },
      {
        key: 'state',
        label: t('nebula.field.status'),
        value: (
          <Badge style={statusTint(INTERNAL_HOST_STATE_COLORS[data.state])}>
            {t(`nebula.hostState.${data.state}`)}
          </Badge>
        )
      },
      {
        key: 'confidence',
        label: t('nebula.field.confidence'),
        value: t(`nebula.confidence.${data.confidence}`)
      },
      {
        key: 'lastSeen',
        label: t('nebula.field.lastSeen'),
        value:
          data.last_seen.trim().length > 0
            ? formatDateTimeFull(data.last_seen)
            : t('nebula.field.none')
      }
    ],
    metrics: [
      { key: 'services', label: t('nebula.field.serviceCount'), value: data.service_count, mono: true },
      { key: 'footholds', label: t('nebula.field.footholdCount'), value: data.foothold_ids.length, mono: true }
    ]
  }
}

/** Internal service: one port on one intranet host. */
function InternalServiceSections(node: InternalServiceNode, t: Translate): NodeSections {
  const { data } = node
  const endpoint = data.ip.trim().length > 0 ? `${data.ip}:${data.port}` : `${data.host_id}:${data.port}`
  return {
    identity: [
      { key: 'endpoint', label: t('nebula.field.serviceEndpoint'), value: endpoint, mono: true },
      {
        key: 'protocol',
        label: t('nebula.field.protocol'),
        value: data.protocol.trim().length > 0 ? data.protocol : t('nebula.field.none')
      },
      {
        key: 'service',
        label: t('nebula.field.service'),
        value: data.service.trim().length > 0 ? data.service : t('nebula.field.none')
      },
      {
        key: 'state',
        label: t('nebula.field.status'),
        value: (
          <Badge style={statusTint(SERVICE_STATE_COLORS[data.state])}>
            {t(`nebula.serviceState.${data.state}`)}
          </Badge>
        )
      },
      {
        key: 'project',
        label: t('nebula.field.project'),
        value: data.project_name.trim().length > 0 ? data.project_name : t('nebula.field.none')
      }
    ],
    metrics: [
      { key: 'vulns', label: t('nebula.field.vulnCount'), value: data.vuln_ids.length, mono: true }
    ]
  }
}

/** Discriminated-union dispatch — no casts, every branch gets its own data type. */
function sectionsFor(node: NebulaNode, t: Translate): NodeSections {
  switch (node.type) {
    case 'project':
      return ProjectSections(node, t)
    case 'target':
      return TargetSections(node, t)
    case 'host':
      return HostSections(node, t)
    case 'vuln':
      return node.data.aggregate === undefined ? VulnSections(node, t) : AggregateSections(node, t)
    case 'leak':
      return node.data.aggregate === undefined ? LeakSections(node, t) : AggregateSections(node, t)
    case 'snapshot':
      return SnapshotSections(node, t)
    case 'foothold':
      return FootholdSections(node, t)
    case 'internal_host':
      return InternalHostSections(node, t)
    case 'internal_service':
      return InternalServiceSections(node, t)
  }
}

/* ------------------------------------------------------------ relations -- */

function RelationRow({
  neighbor,
  onSelectNode
}: {
  neighbor: GraphNeighbor
  onSelectNode: (nodeId: string) => void
}) {
  const { t } = useI18n()
  const outgoing = neighbor.direction === 'outgoing'
  const DirectionIcon = outgoing ? ArrowUpRight : ArrowDownLeft
  const color = nodeColor(neighbor.node)
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => onSelectNode(neighbor.node.id)}
        title={t('nebula.inspector.openNode', { name: neighbor.node.name })}
        className={cn(
          'group flex w-full min-w-0 items-center gap-2 border-l-2 border-transparent py-2 pl-1.5 pr-1 text-left',
          'transition-colors duration-150 hover:border-[#00E5FF]/60 hover:bg-[#00E5FF]/[0.04]',
          NEBULA_UI.focusRing
        )}
      >
        <ColorDot color={color} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[12.5px] text-[#C7E9F5] transition-colors group-hover:text-[#00E5FF]">
            {neighbor.node.name}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.06em] text-[#7FA9BE]">
            <span className="truncate">{t(`nebula.legend.relation.${neighbor.relation}`)}</span>
            {neighbor.derived ? (
              <span
                className={cn(
                  NEBULA_UI.chip,
                  'shrink-0 border-[#FFAA00]/35 bg-[#FFAA00]/[0.08] py-0 text-[10.5px] text-[#FFC766]'
                )}
              >
                {t('nebula.inspector.derived')}
              </span>
            ) : null}
          </span>
        </span>
        <DirectionIcon
          aria-hidden="true"
          className="h-3 w-3 shrink-0 text-[#3E6274] transition-colors group-hover:text-[#00E5FF]"
        />
        <span className="sr-only">{t(`nebula.inspector.direction.${neighbor.direction}`)}</span>
      </button>
    </li>
  )
}

/* ------------------------------------------------------------------ drawer -- */

/**
 * Right-hand HUD drawer: `// INSPECTOR` header with the node type chip, a
 * **compact** per-type summary split into IDENTITY / KEY METRICS (long
 * evidence and inventories live on the dedicated page), the relation network and
 * a "view full details" action. Slide-in on mount only; Esc is owned by the page.
 */
export function NodeInspector({
  node,
  neighbors,
  onClose,
  onSelectNode,
  detailLabel,
  onOpenDetail,
  className
}: NodeInspectorProps) {
  const { t } = useI18n()
  const { copied, copy } = useCopy()
  const [entered, setEntered] = useState(false)

  // Two rAF ticks so the browser paints the off-screen state before animating.
  useEffect(() => {
    let second = 0
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => setEntered(true))
    })
    return () => {
      window.cancelAnimationFrame(first)
      window.cancelAnimationFrame(second)
    }
  }, [])

  const shownNeighbors = neighbors.slice(0, RELATION_LIMIT)
  const sections = sectionsFor(node, t)

  return (
    <aside
      aria-label={t('nebula.inspector.title')}
      className={cn(
        'relative flex h-full w-full flex-col overflow-hidden border-l border-[#00E5FF]/25',
        'bg-[#020A14]/[0.94] backdrop-blur-md shadow-[-24px_0_60px_-30px_rgba(0,0,0,0.95)]',
        'transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none',
        entered ? 'translate-x-0 opacity-100' : 'translate-x-2 opacity-0',
        'motion-reduce:translate-x-0 motion-reduce:opacity-100',
        className
      )}
    >
      {/* Cyan drawer edge: the HUD's 2px accent bar, faded at the bottom. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 z-20 w-[2px] bg-gradient-to-b from-[#00E5FF]/80 via-[#00E5FF]/40 to-transparent"
      />

      <header className="relative z-10 shrink-0 border-b border-[#00E5FF]/[0.12] bg-[#020A14]/90 px-3.5 pb-3 pt-3 backdrop-blur-md">
        <HudPanelHeader
          title={t('nebula.hud.panelInspector')}
          actions={
            <>
              <TypeChip node={node} />
              <HudButton
                size="icon"
                variant="ghost"
                aria-label={t('nebula.inspector.copyJson')}
                title={t('nebula.inspector.copyJson')}
                onClick={() => void copy(JSON.stringify(node, null, 2), t('nebula.inspector.copied'))}
              >
                {copied ? (
                  <Check aria-hidden="true" className="h-3.5 w-3.5 text-[#10B981]" />
                ) : (
                  <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                )}
              </HudButton>
              <HudButton
                size="icon"
                variant="ghost"
                aria-label={t('nebula.inspector.close')}
                title={t('nebula.inspector.close')}
                onClick={onClose}
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </HudButton>
            </>
          }
          className="px-0 pt-0"
        />
        <h3 className="mt-2 break-words font-mono text-[13px] leading-snug tracking-[0.02em] text-[#E6F7FF]">
          {node.name}
        </h3>
        <p
          className="mt-1 truncate font-mono text-[10.5px] tracking-[0.06em] text-[#7FA9BE]"
          title={node.id}
        >
          {node.id}
        </p>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {/* Keyed by node id so local state resets when selection changes. */}
        <div key={node.id}>
          <HudSectionTitle>{t('nebula.inspector.identity')}</HudSectionTitle>
          <SummaryRows rows={sections.identity} />

          {sections.metrics.length > 0 ? (
            <>
              <HudSectionTitle className="mt-3.5">
                {t('nebula.inspector.metrics')}
              </HudSectionTitle>
              <SummaryRows rows={sections.metrics} />
            </>
          ) : null}

          {sections.note}

          <HudSectionTitle
            className="mt-3.5"
            trailing={
              neighbors.length > 0 ? String(neighbors.length).padStart(2, '0') : undefined
            }
          >
            {t('nebula.inspector.network')}
          </HudSectionTitle>
          {neighbors.length === 0 ? (
            <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-[#7FA9BE]">
              {t('nebula.inspector.noRelations')}
            </p>
          ) : (
            <>
              <ul className="mt-1 divide-y divide-[#00E5FF]/[0.07]">
                {shownNeighbors.map((neighbor, index) => (
                  <RelationRow
                    key={`${neighbor.node.id}-${neighbor.relation}-${neighbor.direction}-${index}`}
                    neighbor={neighbor}
                    onSelectNode={onSelectNode}
                  />
                ))}
              </ul>
              {neighbors.length > shownNeighbors.length ? (
                <p className="mt-1.5 font-mono text-[11px] text-[#7FA9BE]">
                  {t('nebula.inspector.relationsMore', {
                    count: neighbors.length - shownNeighbors.length
                  })}
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>

      {detailLabel !== null ? (
        <footer className="relative z-10 shrink-0 border-t border-[#00E5FF]/[0.12] bg-[#020A14]/90 px-3.5 py-3 backdrop-blur-md">
          <HudButton
            variant="primary"
            onClick={onOpenDetail}
            className="h-9 w-full gap-2 text-[11px] tracking-[0.06em]"
          >
            <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
            {detailLabel}
          </HudButton>
        </footer>
      ) : null}
    </aside>
  )
}
