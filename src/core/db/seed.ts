import type { DatabaseService } from './DatabaseService'
import { createDemoAssets } from './demoAssets'
import { createDemoSnapshots } from './demoSnapshots'
import { createDemoVulnerabilities } from './demoVulns'

/**
 * Insert the bundled demo fixtures. Refuses to touch a non-empty database
 * unless `force` is set, so a real pentest archive is never polluted by
 * accident.
 *
 * Return value stays the number of inserted vulnerabilities: callers (IPC
 * handler, bootstrap log) use it to decide whether the database was seeded, and
 * the snapshot fixtures must not change that contract.
 *
 * The snapshot demo is one project session with two child system sessions; the
 * second child is archived. The project session gets one partial update so the
 * single-step rollback state is available for screenshots.
 */
export function seedDemoData(
  db: DatabaseService,
  options: { force?: boolean; now?: Date } = {}
): number {
  if (!options.force && db.count() > 0) return 0
  const now = options.now ?? new Date()
  const vulns = createDemoVulnerabilities(now)
  for (const vuln of vulns) {
    db.saveVulnerability(vuln)
  }
  for (const asset of createDemoAssets(now)) {
    db.upsertAssetContext(asset, 'replace')
  }

  const { project, children } = createDemoSnapshots(now)
  const projectSession = db.createSnapshotSession(project, now)

  db.updateSnapshotSession(
    projectSession.session_id,
    {
      current_phase: '门户系统 4 类问题已确认，工单系统暂停待授权，准备汇总报告',
      next_steps:
        '补齐门户 IDOR 证据，等待工单系统授权后恢复；完成两个子会话后再统一导出报告。'
    },
    {},
    new Date(now.getTime() + 60_000)
  )

  children.forEach((child, index) => {
    const createdAt = new Date(now.getTime() + (index + 1) * 1_000)
    const childSession = db.createSnapshotSession(
      child.payload,
      createdAt,
      projectSession.session_id
    )
    if (child.archived) {
      db.setSnapshotArchived(childSession.session_id, true, new Date(now.getTime() + 600_000))
    }
  })

  return vulns.length
}
