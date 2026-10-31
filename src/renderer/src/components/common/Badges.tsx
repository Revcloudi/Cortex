import type { AssetStatus, LeakedInfoType, Severity, VulnStatus } from '@shared/types'
import { Badge } from '@renderer/components/ui/badge'
import { useI18n } from '@renderer/i18n'
import { SEVERITY_STYLES, STATUS_STYLES } from '@renderer/lib/severity'
import { ASSET_STATUS_STYLES, LEAK_TYPE_STYLES } from '@renderer/lib/assets'
import { cn } from '@renderer/lib/utils'

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  const { severityLabel } = useI18n()
  const style = SEVERITY_STYLES[severity]
  return (
    <Badge className={cn(style.badge, className)}>
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
      {severityLabel(severity)}
    </Badge>
  )
}

export function StatusBadge({ status, className }: { status: VulnStatus; className?: string }) {
  const { statusLabel } = useI18n()
  const style = STATUS_STYLES[status]
  return (
    <Badge className={cn(style.badge, className)}>
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
      {statusLabel(status)}
    </Badge>
  )
}

export function AssetStatusBadge({
  status,
  className
}: {
  status: AssetStatus
  className?: string
}) {
  const { assetStatusLabel } = useI18n()
  const style = ASSET_STATUS_STYLES[status]
  return (
    <Badge className={cn(style.badge, 'whitespace-nowrap', className)}>
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
      {assetStatusLabel(status)}
    </Badge>
  )
}

export function LeakTypeBadge({
  type,
  className
}: {
  type: LeakedInfoType
  className?: string
}) {
  const { t } = useI18n()
  return (
    <Badge className={cn(LEAK_TYPE_STYLES[type], 'font-mono text-[10px]', className)}>
      {t(`ui.leakType.${type}`)}
    </Badge>
  )
}
