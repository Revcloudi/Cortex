import type { Vulnerability } from '../../shared/types'
import { SEVERITY_LABELS } from '../../shared/types'

/** Treats the localized none sentinel as not applicable, so no section is emitted. */
function hasMeaningfulCrypto(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized.length > 0 && !['无', 'none', 'n/a', 'na'].includes(normalized)
}

function sectionText(value: string): string {
  return value.trim().length > 0 ? value.trim() : '未记录。'
}

function interfacesSection(interfaces: string[]): string {
  if (interfaces.length === 0) return '未记录。'
  return interfaces.map((item, index) => `${index + 1}. \`${item}\``).join('\n')
}

function remediationSection(remediation: string[]): string {
  if (remediation.length === 0) return '未记录。'
  return remediation.map((item) => item.trim()).join('\n\n')
}

function boundariesSection(boundaries: string): string {
  const lines = boundaries
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ''))
    .filter((line) => line.length > 0)
  if (lines.length === 0) return '- 未记录。'
  return lines.map((line) => `- ${line}`).join('\n')
}

/**
 * Markdown report in the same structure as the team's SRC report template:
 * title, target URL, severity, description, impact, interfaces, reproduction
 * steps, remediation and the test-boundaries appendix.
 */
export function buildVulnerabilityReportMarkdown(vuln: Vulnerability): string {
  const cryptoSection = hasMeaningfulCrypto(vuln.crypto_details)
    ? ['---', '', '## 加解密说明', '', vuln.crypto_details.trim(), '']
    : []

  const blocks: string[] = [
    `# ${vuln.vuln_name.trim()}`,
    '',
    `**目标网站URL：** ${vuln.target_url.trim()}`,
    '',
    `**漏洞等级：** ${SEVERITY_LABELS[vuln.severity]}`,
    '',
    '---',
    '',
    '## 漏洞描述',
    '',
    sectionText(vuln.description),
    '',
    '## 漏洞危害',
    '',
    sectionText(vuln.impact),
    '',
    '## 涉及接口清单',
    '',
    interfacesSection(vuln.affected_interfaces),
    '',
    '---',
    '',
    '## 复现步骤',
    '',
    sectionText(vuln.reproduction_steps),
    '',
    ...cryptoSection,
    '---',
    '',
    '## 修复建议',
    '',
    remediationSection(vuln.remediation),
    '',
    '---',
    '',
    '## 附：本次测试的边界与未做事项',
    '',
    boundariesSection(vuln.test_boundaries),
    ''
  ]

  return `${blocks.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/** Convert a vulnerability title into a safe, readable Markdown filename. */
export function buildReportFilename(vuln: Vulnerability): string {
  const raw = (vuln.vuln_name || vuln.id).trim()
  const safe = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 120)
  return `${safe || vuln.id}.md`
}
