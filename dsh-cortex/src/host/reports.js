/**
 * Markdown report generation for GET /reports/:vulnId (contract §2.6).
 * Read-only: takes a VulnDetail DTO plus related VulnSummary DTOs.
 */

/** Collapse embedded newlines so a value stays on one Markdown list line. */
function inline(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\r?\n+/g, ' ')
    .trim()
}

/** @param {string} value */
function sectionBody(value) {
  const text = String(value === null || value === undefined ? '' : value).trim()
  return text.length > 0 ? text : '_（无）_'
}

/** @param {string[]} items */
function bulletList(items) {
  const list = Array.isArray(items) ? items.filter((item) => String(item ?? '').trim().length > 0) : []
  if (list.length === 0) return '_（无）_'
  return list.map((item) => `- ${String(item).replace(/\r?\n+/g, ' ').trim()}`).join('\n')
}

/**
 * Build the full Markdown report.
 * @param {Record<string, any>} vuln VulnDetail DTO
 * @param {Record<string, any>[]} [related] VulnSummary DTOs
 * @returns {string}
 */
export function buildVulnReport(vuln, related = []) {
  const source = vuln || {}
  const lines = []

  lines.push(`# ${inline(source.vulnName) || inline(source.id) || 'Vulnerability'}`)
  lines.push('')
  lines.push(`- 漏洞 ID: ${inline(source.id)}`)
  lines.push(`- Host: ${inline(source.host)}`)
  lines.push(`- 入口: ${inline(source.entryPoint)}`)
  lines.push(`- 类型: ${inline(source.vulnType)}`)
  lines.push(`- 严重级别: ${inline(source.severity)}`)
  lines.push(`- 状态: ${inline(source.status)}`)
  lines.push(`- 时间: ${inline(source.createdAt)}`)
  lines.push('')

  lines.push('## 描述')
  lines.push('')
  lines.push(sectionBody(source.description))
  lines.push('')

  lines.push('## 影响')
  lines.push('')
  lines.push(sectionBody(source.impact))
  lines.push('')

  lines.push('## 受影响接口')
  lines.push('')
  lines.push(bulletList(source.affectedInterfaces))
  lines.push('')

  lines.push('## 复现步骤')
  lines.push('')
  lines.push(sectionBody(source.reproductionSteps))
  lines.push('')

  const retests = Array.isArray(source.retestResults) ? source.retestResults : []
  if (retests.length > 0) {
    lines.push('## 复测记录')
    lines.push('')
    retests.forEach((entry, index) => {
      lines.push(`### 复测 ${index + 1}`)
      lines.push('')
      lines.push(`- 时间范围: ${inline(entry && entry.timeRange)}`)
      lines.push('')
      lines.push(sectionBody(entry && entry.conclusion))
      lines.push('')
    })
  }

  lines.push('## 修复建议')
  lines.push('')
  lines.push(bulletList(source.remediation))
  lines.push('')

  const cryptoDetails = String(source.cryptoDetails || '').trim()
  const testBoundaries = String(source.testBoundaries || '').trim()
  if (cryptoDetails.length > 0 || testBoundaries.length > 0) {
    lines.push('## 测试边界 / 加密细节')
    lines.push('')
    if (testBoundaries.length > 0) {
      lines.push('### 测试边界')
      lines.push('')
      lines.push(testBoundaries)
      lines.push('')
    }
    if (cryptoDetails.length > 0) {
      lines.push('### 加密细节')
      lines.push('')
      lines.push(cryptoDetails)
      lines.push('')
    }
  }

  lines.push('## 关联漏洞')
  lines.push('')
  const relatedList = Array.isArray(related) ? related.filter(Boolean) : []
  if (relatedList.length === 0) {
    lines.push('_（无）_')
    lines.push('')
  } else {
    for (const item of relatedList) {
      const name = inline(item.vulnName)
      lines.push(`- ${inline(item.id)}${name.length > 0 ? ` ${name}` : ''}`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

/**
 * Safe attachment filename for a report: `VULN-....md`.
 * @param {string} vulnId
 */
export function reportFilename(vulnId) {
  const base = String(vulnId || 'vulnerability')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100)
  return `${base || 'vulnerability'}.md`
}
