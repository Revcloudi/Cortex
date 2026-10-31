import type { MessageBundle } from './types'

/**
 * Shared UI chrome: sidebar, common components, generic formatters.
 *
 * Keys here must stay product-agnostic and reusable across pages; page-specific
 * copy belongs in the page bundle (`mcp.*`, `vuln.*`, `snapshot.*`, ...).
 */
export const uiMessages: MessageBundle = {
  zh: {
    // Shell / sidebar chrome
    'ui.sidebar.mainNav': '主导航',
    'ui.sheet.closeDetail': '关闭详情',

    // Page metadata (consumed through lib/navigation.ts)
    'ui.pageMeta.dashboard.description': '本次测试的漏洞记忆，本地 SQLite 持久化',
    'ui.pageMeta.assets.description': 'Agent 侦察到的资产指纹、接口目录与敏感泄露',
    'ui.pageMeta.snapshots.description': '单任务单会话的战术进度：未完成任务、失败路径与下一步',
    'ui.pageMeta.mcp.description': 'Agent 以 stdio 拉起 MCP server，读写同一份本地数据库',

    // Copy affordances
    'ui.copy.copiedToClipboard': '已复制到剪贴板',
    'ui.copy.failed': '复制失败，请手动选择文本',
    'ui.codeBlock.copy': '复制{label}',
    'ui.codeBlock.copied': '已复制{label}',

    // Shared badges
    'ui.leakType.Credential': '凭据',
    'ui.leakType.API_Key': 'API Key',
    'ui.leakType.Token': 'Token',
    'ui.leakType.PII': 'PII',
    'ui.leakType.Internal_IP': '内网 IP',
    'ui.leakType.Other': '其他',

    // Generic formatters
    'ui.uptime.lessThanMinute': '不足 1 分钟',
    'ui.uptime.minutes': '分钟',
    'ui.uptime.hours': '小时',
    'ui.vulnType.unclassified': '未分类'
  },
  en: {
    // Shell / sidebar chrome
    'ui.sidebar.mainNav': 'Main navigation',
    'ui.sheet.closeDetail': 'Close details',

    // Page metadata (consumed through lib/navigation.ts)
    'ui.pageMeta.dashboard.description':
      'Vulnerability memory for this engagement, persisted in local SQLite',
    'ui.pageMeta.assets.description':
      'Asset fingerprints, interface inventory and leaked secrets discovered by the agent',
    'ui.pageMeta.snapshots.description':
      'One session per task: unfinished tasks, failed paths and next steps',
    'ui.pageMeta.mcp.description':
      'The agent launches the MCP server over stdio and shares the same local database',

    // Copy affordances
    'ui.copy.copiedToClipboard': 'Copied to clipboard',
    'ui.copy.failed': 'Copy failed. Select the text and copy it manually.',
    'ui.codeBlock.copy': 'Copy {label}',
    'ui.codeBlock.copied': 'Copied {label}',

    // Shared badges
    'ui.leakType.Credential': 'Credential',
    'ui.leakType.API_Key': 'API Key',
    'ui.leakType.Token': 'Token',
    'ui.leakType.PII': 'PII',
    'ui.leakType.Internal_IP': 'Internal IP',
    'ui.leakType.Other': 'Other',

    // Generic formatters
    'ui.uptime.lessThanMinute': 'Less than 1 minute',
    'ui.uptime.minutes': 'min',
    'ui.uptime.hours': 'h',
    'ui.vulnType.unclassified': 'Unclassified'
  }
}
