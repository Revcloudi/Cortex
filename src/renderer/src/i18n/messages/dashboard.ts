import type { MessageBundle } from './types'

export const dashboardMessages: MessageBundle = {
  zh: {
    'dashboard.metric.total': '总漏洞数',
    'dashboard.metric.critical': '严重漏洞数',
    'dashboard.metric.hosts': '涉及 Host 数',
    'dashboard.metric.today': '今日新增',
    'dashboard.metric.loading': '正在加载统计数据',
    'dashboard.metric.unavailable': '统计数据不可用',
    'dashboard.metric.totalContext': '已确认 {confirmed} · 待定 {inconclusive}',
    'dashboard.metric.criticalContext': '占全部 {percent}% · 高危 {high} 条',
    'dashboard.metric.hostsContext': '平均 {average} 条 / Host',
    'dashboard.metric.todayContext': '本地时间自 00:00 起写入',
    'dashboard.seed.loaded': '已载入 {count} 条示例数据',
    'dashboard.seed.exists': '示例数据已存在，未重复写入',
    'dashboard.seed.failed': '载入示例数据失败：{error}',
    'dashboard.bulk.region': '批量操作',
    'dashboard.bulk.selected': '已选 {count} 条',
    'dashboard.bulk.exporting': '正在导出…',
    'dashboard.bulk.export': '导出 MD',
    'dashboard.bulk.deleteSelected': '删除选中',
    'dashboard.bulk.cancelSelection': '取消选择'
  },
  en: {
    'dashboard.metric.total': 'Total vulnerabilities',
    'dashboard.metric.critical': 'Critical vulnerabilities',
    'dashboard.metric.hosts': 'Affected hosts',
    'dashboard.metric.today': 'Added today',
    'dashboard.metric.loading': 'Loading statistics',
    'dashboard.metric.unavailable': 'Statistics unavailable',
    'dashboard.metric.totalContext': 'Confirmed {confirmed} · Inconclusive {inconclusive}',
    'dashboard.metric.criticalContext': '{percent}% of all · {high} high',
    'dashboard.metric.hostsContext': '{average} per host',
    'dashboard.metric.todayContext': 'Written since 00:00 local time',
    'dashboard.seed.loaded': 'Loaded {count} demo records',
    'dashboard.seed.exists': 'Demo data already exists; nothing was inserted',
    'dashboard.seed.failed': 'Failed to load demo data: {error}',
    'dashboard.bulk.region': 'Bulk actions',
    'dashboard.bulk.selected': '{count} selected',
    'dashboard.bulk.exporting': 'Exporting…',
    'dashboard.bulk.export': 'Export MD',
    'dashboard.bulk.deleteSelected': 'Delete selected',
    'dashboard.bulk.cancelSelection': 'Clear selection'
  }
}
