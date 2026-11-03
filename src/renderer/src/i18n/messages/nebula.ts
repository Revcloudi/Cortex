import type { MessageBundle } from './types'

/**
 * Memory Nebula copy (P1).
 *
 * Every string the 3D view renders lives here, zh + en in lockstep. Mock graph
 * *data* (host names, vuln titles, …) is data, not copy, and stays untranslated.
 */
export const nebulaMessages: MessageBundle = {
  zh: {
    // Navigation + page metadata
    'nav.nebula': '记忆星云',
    'ui.pageMeta.nebula.description': '资产、漏洞、泄露与快照的 3D 关联星云（P1 Mock 视觉版）',

    // Header
    'nebula.title': '记忆星云',
    'nebula.subtitle': '一次看清整条记忆网络的形态',
    'nebula.mockBadge': 'Mock 演示',
    'nebula.mockHint': 'P1 使用内置 Mock 数据，未连接真实数据库。',

    // Scope switch
    'nebula.scope.label': '视图范围',
    'nebula.scope.all': '全库',
    'nebula.scope.asset': '当前资产',
    'nebula.scope.task': '当前任务',
    'nebula.scope.assetHint': 'Mock 固定示例：10.0.0.5:8080',
    'nebula.scope.taskHint': 'Mock 固定示例：Example SRC / 登录接口测试',
    'nebula.scope.switchAria': '切换视图范围',

    // Search
    'nebula.search.placeholder': '搜索 Host、漏洞、泄露、快照…',
    'nebula.search.ariaLabel': '在星云中搜索节点',
    'nebula.search.clear': '清除搜索',
    'nebula.search.matchCount': '{count} 个匹配',
    'nebula.search.noMatch': '没有匹配节点',

    // Type filters
    'nebula.filter.label': '类型过滤',
    'nebula.filter.vulns': '漏洞',
    'nebula.filter.leaks': '敏感泄露',
    'nebula.filter.snapshots': '快照',
    'nebula.filter.hostsAlwaysVisible': 'Host 始终显示',

    // Statistics
    'nebula.stats.nodes': '{count} 节点',
    'nebula.stats.links': '{count} 连线',
    'nebula.stats.visible': '当前 {visible} / 共 {total}',

    // Camera
    'nebula.resetView': '重置视角',
    'nebula.resetViewAria': '重置相机视角',
    'nebula.helper.hint': '拖拽旋转 · 滚轮缩放 · 点击节点查看详情',

    // Legend
    'nebula.legend.title': '图例',
    'nebula.legend.project': '项目',
    'nebula.legend.target': '目标',
    'nebula.legend.host': 'Host 资产',
    'nebula.legend.vuln': '漏洞（按严重程度着色）',
    'nebula.legend.leak': '敏感泄露',
    'nebula.legend.snapshot': '认知快照',
    'nebula.legend.relation.title': '关系',
    'nebula.legend.relation.BELONGS_TO': '归属 → 项目',
    'nebula.legend.relation.TARGET_SESSION': '目标 → 任务快照',
    'nebula.legend.relation.TARGET_ASSET': '目标 → 资产/内网服务',
    'nebula.legend.relation.HAS_VULN': '资产 → 漏洞',
    'nebula.legend.relation.LEAKED': '资产 → 泄露',
    'nebula.legend.relation.RELATED_VULN': '漏洞 ↔ 关联漏洞',
    'nebula.legend.relation.SNAPSHOT_TARGETS': '快照 → 目标资产',
    'nebula.legend.relation.SNAPSHOT_VULN': '快照 → 关联漏洞',
    'nebula.legend.relation.TASK_TOUCHED_HOST': '快照 → 任务触及的漏洞',
    'nebula.legend.derived': '更淡的连线表示推导关系',
    'nebula.legend.expand': '展开图例',
    'nebula.legend.collapse': '收起图例',
    'nebula.legend.derivedHint':
      '推导关系由 Host 匹配或任务目标推断，并非数据库中显式存储的关联；渲染时透明度更低、线宽更细。',

    // Node types
    'nebula.type.project': '项目',
    'nebula.type.target': '目标',
    'nebula.type.host': 'Host',
    'nebula.type.vuln': '漏洞',
    'nebula.type.leak': '泄露',
    'nebula.type.snapshot': '快照',

    // Inspector chrome
    'nebula.inspector.title': '节点详情',
    'nebula.inspector.close': '关闭详情',
    'nebula.inspector.rawJson': '原始 JSON',
    'nebula.inspector.copy': '复制',
    'nebula.inspector.copied': '已复制',
    'nebula.inspector.copyJson': '复制 JSON',
    'nebula.inspector.relations': '关联节点（{count}）',
    'nebula.inspector.moreInterfaces': '还有 {count} 个接口',
    'nebula.inspector.noRelations': '该节点在当前视图中没有关联。',
    'nebula.inspector.openNode': '查看 {name}',
    'nebula.inspector.truncated': '已截断',
    'nebula.inspector.showMore': '展开全文',
    'nebula.inspector.showLess': '收起',
    'nebula.inspector.derived': '推导',
    'nebula.inspector.direction.outgoing': '出边',
    'nebula.inspector.direction.incoming': '入边',

    // Inspector field labels
    'nebula.field.hostPort': 'Host',
    'nebula.field.project': '项目',
    'nebula.field.techStack': '技术栈',
    'nebula.field.status': '状态',
    'nebula.field.interfaces': '接口数',
    'nebula.field.leaks': '泄露数',
    'nebula.field.lastSeen': '最后发现',
    'nebula.field.testParameters': '测试参数',
    'nebula.field.assetCount': '资产数 {count}',
    'nebula.field.sessionCount': '任务数 {count}',
    'nebula.field.target': '目标',
    'nebula.field.hostKey': 'Host Key',
    'nebula.field.serviceHost': '内网服务',
    'nebula.field.host': '所属 Host',
    'nebula.field.severity': '严重程度',
    'nebula.field.vulnType': '漏洞类型',
    'nebula.field.targetUrl': '目标 URL',
    'nebula.field.vulnId': '漏洞 ID',
    'nebula.field.createdAt': '发现时间',
    'nebula.field.reproduction': '复现步骤摘要',
    'nebula.field.relatedVulns': '关联漏洞',
    'nebula.field.infoType': '泄露类型',
    'nebula.field.value': '值',
    'nebula.field.source': '来源',
    'nebula.field.impact': '潜在影响',
    'nebula.field.session': '会话',
    'nebula.field.phase': '当前阶段',
    'nebula.field.targetHosts': '目标 Host',
    'nebula.field.nextSteps': '下一步',
    'nebula.field.unfinishedTasks': '未完成任务',
    'nebula.field.parentSession': '父会话',
    'nebula.field.updatedAt': '更新时间',
    'nebula.field.nodeId': '节点 ID',
    'nebula.field.weight': '权重',
    'nebula.field.none': '无',

    // Empty / degraded states
    'nebula.empty.title': '当前范围没有节点',
    'nebula.empty.description': '换一个视图范围，或重新打开类型过滤。',
    'nebula.empty.filteredTitle': '过滤器隐藏了全部节点',
    'nebula.empty.filteredDescription':
      '已隐藏所有漏洞、泄露与快照，只剩 Host。重新打开任一类型即可看到完整星云。',
    'nebula.empty.resetFilters': '重置过滤器',
    'nebula.empty.noMatchTitle': '没有匹配的节点',
    'nebula.empty.noMatchDescription': '搜索只做高亮，不会删除节点；换一个关键词试试。',
    'nebula.empty.clearSearch': '清除搜索',
    'nebula.loading': '正在加载星云…',
    'nebula.canvas.ariaLabel': '3D 记忆星云图：可拖拽旋转、滚轮缩放，点击节点查看详情',

    // Safety / limits
    'nebula.truncated': '星云已截断，仅展示前 {count} 个节点',
    'nebula.performance.title': '图谱较大，已降低渲染质量',
    'nebula.performance.description':
      '当前 {nodes} 个节点、{links} 条连线；超过 {limit} 时请使用类型过滤，或切到「全库」Scope 使用聚合节点。',
    'nebula.webglUnavailable.title': '无法启动 3D 渲染',
    'nebula.webglUnavailable.description':
      '当前浏览器或显卡不支持 WebGL。请更新浏览器、开启硬件加速，或改用桌面端。',

    // P2 live data: builder limits, refresh, real scope targets
    'nebula.badge.live': '实时数据',
    'nebula.limits.hint': '上限 {hosts} Host · {vulns} 漏洞 · {leaks} 泄露 · {snapshots} 快照',
    'nebula.refresh': '刷新数据',
    'nebula.refreshAria': '从数据库重新加载星云',
    'nebula.loading.graph': '正在从数据库加载星云…',
    'nebula.error.title': '加载图谱失败',
    'nebula.error.retry': '重试',
    'nebula.truncated.banner':
      '已达图谱上限，当前为部分数据：{hosts} Host / {vulns} 漏洞 / {leaks} 泄露 / {snapshots} 快照',
    'nebula.unresolved': '{count} 个快照目标 Host 未匹配到资产',
    'nebula.scope.hostLabel': '选择资产',
    'nebula.scope.selectPlaceholder': '请选择…',
    'nebula.scope.sessionLabel': '选择任务',
    'nebula.scope.includeChildren': '包含子会话',
    'nebula.scope.assetEmpty': '数据库中还没有资产',
    'nebula.scope.taskEmpty': '数据库中还没有快照',
    'nebula.empty.databaseTitle': '数据库里还没有可绘制的图谱',
    'nebula.empty.databaseDescription':
      '用 Agent 写入资产、漏洞或认知快照后，这里会自动出现星云。',
    'nebula.empty.assetTargetTitle': '先选择一个资产',
    'nebula.empty.assetTargetDescription': '从上方下拉框选择要聚焦的资产。',
    'nebula.empty.taskTargetTitle': '先选择一个任务',
    'nebula.empty.taskTargetDescription': '从上方下拉框选择要聚焦的快照会话。',

    // P3 experience: focus neighbourhood, performance mode, fullscreen, export
    'nebula.focus.label': '聚焦邻域',
    'nebula.focus.toggle': '只高亮选中节点的邻域',
    'nebula.focus.depth1': '1 跳',
    'nebula.focus.depth2': '2 跳',
    'nebula.focus.hintSelect': '选中一个节点后高亮其邻域',
    'nebula.focus.active': '已聚焦 {count} 个节点',
    'nebula.performance.mode': '性能模式：已关闭常驻标签与光晕',
    'nebula.fullscreen.enter': '全屏查看',
    'nebula.fullscreen.exit': '退出全屏',
    'nebula.export.png': '导出 PNG',
    'nebula.export.success': '已导出 PNG',
    'nebula.export.failed': '导出失败：无法读取画布',
    'nebula.webglLost.title': '3D 上下文已丢失',
    'nebula.webglLost.description':
      '浏览器回收了 WebGL 上下文，通常是显存紧张或页面长时间后台导致。可尝试恢复，或重新加载页面。',
    'nebula.webglLost.restore': '重新加载',
    'nebula.webglLost.retry': '尝试恢复',

    // P3 aggregation
    'nebula.aggregate.countLabel': '记录数',
    'nebula.aggregate.severityLabel': '最高严重程度',
    'nebula.aggregate.samplesLabel': '示例记录',
    'nebula.aggregate.hint': '大图下同一 Host 的多条记录会折叠为 +N。聚焦该 Host 或切换到资产视图可查看单条记录。',
    'nebula.legend.aggregate': '+N = 聚合节点（点击查看）',
    'nebula.mode2d.label': '2D 降级视图（当前环境不支持 WebGL）',

    // Summary drawer → full detail pages
    'nebula.detail.openVuln': '在漏洞看板中打开',
    'nebula.detail.openAsset': '在资产库中打开',
    'nebula.detail.openSnapshot': '在认知快照中打开',
    'nebula.inspector.relatedCount': '关联漏洞 {count} 个',
    'nebula.inspector.relationsMore': '还有 {count} 个关联节点',

    // J.A.R.V.I.S. tactical HUD chrome (all uppercase/mono in the UI)
    'nebula.hud.brand': 'CORTEX // NEBULA',
    'nebula.hud.subtitleOnline': '系统在线 · 目标锁定',
    'nebula.hud.subtitleLoading': '系统同步中 · 正在拉取图数据',
    'nebula.hud.subtitleError': '系统离线 · 数据不可用',
    'nebula.hud.subtitleDegraded': '系统受限 · 数据已截断',
    'nebula.hud.system': '系统',
    'nebula.hud.statHosts': '资产',
    'nebula.hud.statVulns': '漏洞',
    'nebula.hud.statLeaks': '泄露',
    'nebula.hud.statSnapshots': '快照',
    'nebula.hud.statCritical': '严重',
    'nebula.hud.statNodes': '节点',
    'nebula.hud.statLinks': '连线',
    'nebula.hud.scopeLabel': '范围',
    'nebula.hud.updated': '更新 {time}',
    'nebula.hud.updatedNone': '更新 —',
    'nebula.hud.shortcuts': '操作',
    'nebula.hud.drag': '拖拽旋转',
    'nebula.hud.wheel': '滚轮缩放',
    'nebula.hud.click': '点击查看',
    'nebula.hud.esc': 'Esc 关闭',
    'nebula.hud.modePerformance': '性能模式',
    'nebula.hud.mode2d': '2D 降级',
    'nebula.hud.labels': '标签 {visible}/{total}',
    'nebula.hud.panelControl': '控制台',
    'nebula.hud.panelLegend': '图例',
    'nebula.hud.panelInspector': '节点档案',
    'nebula.hud.liveFeed': '实时数据流',
    'nebula.hud.targetLocked': '目标锁定',
    'nebula.hud.dataSource': '数据源 /api/graph',
    'nebula.hud.reducedMotion': '动效已减弱',
    'nebula.hud.noData': '无数据',
    'nebula.hud.legendNodes': '节点类型',
    'nebula.hud.legendRelations': '关系',
    'nebula.inspector.identity': '身份信息',
    'nebula.inspector.network': '关系网络',
    'nebula.inspector.metrics': '关键指标',

    // Projected HUD label summaries (short node labels, follow zh/en)
    'nebula.label.leakSummary': '{type}泄露'
  },
  en: {
    // Navigation + page metadata
    'nav.nebula': 'Memory Nebula',
    'ui.pageMeta.nebula.description':
      'A 3D view of how assets, vulnerabilities, leaks and snapshots connect (P1 mock)',

    // Header
    'nebula.title': 'Memory Nebula',
    'nebula.subtitle': 'The shape of the entire memory network at a glance',
    'nebula.mockBadge': 'Mock demo',
    'nebula.mockHint':
      'P1 renders built-in mock data; it is not connected to the real database yet.',

    // Scope switch
    'nebula.scope.label': 'Scope',
    'nebula.scope.all': 'All memory',
    'nebula.scope.asset': 'Asset',
    'nebula.scope.task': 'Task',
    'nebula.scope.assetHint': 'Mock example: 10.0.0.5:8080',
    'nebula.scope.taskHint': 'Mock example: Example SRC / Login API test',
    'nebula.scope.switchAria': 'Switch graph scope',

    // Search
    'nebula.search.placeholder': 'Search hosts, vulns, leaks, snapshots…',
    'nebula.search.ariaLabel': 'Search nodes in the nebula',
    'nebula.search.clear': 'Clear search',
    'nebula.search.matchCount': '{count} matches',
    'nebula.search.noMatch': 'No matching nodes',

    // Type filters
    'nebula.filter.label': 'Node types',
    'nebula.filter.vulns': 'Vulnerabilities',
    'nebula.filter.leaks': 'Leaks',
    'nebula.filter.snapshots': 'Snapshots',
    'nebula.filter.hostsAlwaysVisible': 'Hosts are always shown',

    // Statistics
    'nebula.stats.nodes': '{count} nodes',
    'nebula.stats.links': '{count} links',
    'nebula.stats.visible': 'Showing {visible} of {total}',

    // Camera
    'nebula.resetView': 'Reset view',
    'nebula.resetViewAria': 'Reset camera view',
    'nebula.helper.hint': 'Drag to rotate · scroll to zoom · click a node to inspect',

    // Legend
    'nebula.legend.title': 'Legend',
    'nebula.legend.project': 'Project',
    'nebula.legend.target': 'Target',
    'nebula.legend.host': 'Host asset',
    'nebula.legend.vuln': 'Vulnerability (coloured by severity)',
    'nebula.legend.leak': 'Leaked secret',
    'nebula.legend.snapshot': 'Cognitive snapshot',
    'nebula.legend.relation.title': 'Relations',
    'nebula.legend.relation.BELONGS_TO': 'Belongs to project',
    'nebula.legend.relation.TARGET_SESSION': 'Target → task snapshot',
    'nebula.legend.relation.TARGET_ASSET': 'Target → asset / internal service',
    'nebula.legend.relation.HAS_VULN': 'Host → vulnerability',
    'nebula.legend.relation.LEAKED': 'Host → leak',
    'nebula.legend.relation.RELATED_VULN': 'Vulnerability ↔ related',
    'nebula.legend.relation.SNAPSHOT_TARGETS': 'Snapshot → target host',
    'nebula.legend.relation.SNAPSHOT_VULN': 'Snapshot → linked vulnerability',
    'nebula.legend.relation.TASK_TOUCHED_HOST': 'Snapshot → vulnerability touched by task',
    'nebula.legend.derived': 'Fainter edges are derived',
    'nebula.legend.expand': 'Expand legend',
    'nebula.legend.collapse': 'Collapse legend',
    'nebula.legend.derivedHint':
      'Derived edges are inferred from host matching or task targets — they are not stored links, so they render fainter and thinner.',

    // Node types
    'nebula.type.project': 'Project',
    'nebula.type.target': 'Target',
    'nebula.type.host': 'Host',
    'nebula.type.vuln': 'Vulnerability',
    'nebula.type.leak': 'Leak',
    'nebula.type.snapshot': 'Snapshot',

    // Inspector chrome
    'nebula.inspector.title': 'Node details',
    'nebula.inspector.close': 'Close details',
    'nebula.inspector.rawJson': 'Raw JSON',
    'nebula.inspector.copy': 'Copy',
    'nebula.inspector.copied': 'Copied',
    'nebula.inspector.copyJson': 'Copy JSON',
    'nebula.inspector.relations': 'Related nodes ({count})',
    'nebula.inspector.moreInterfaces': '{count} more interfaces',
    'nebula.inspector.noRelations': 'This node has no relations in the current view.',
    'nebula.inspector.openNode': 'Open {name}',
    'nebula.inspector.truncated': 'Truncated',
    'nebula.inspector.showMore': 'Show full value',
    'nebula.inspector.showLess': 'Collapse',
    'nebula.inspector.derived': 'Derived',
    'nebula.inspector.direction.outgoing': 'Outgoing',
    'nebula.inspector.direction.incoming': 'Incoming',

    // Inspector field labels
    'nebula.field.hostPort': 'Host',
    'nebula.field.project': 'Project',
    'nebula.field.techStack': 'Tech stack',
    'nebula.field.status': 'Status',
    'nebula.field.interfaces': 'Interfaces',
    'nebula.field.leaks': 'Leaks',
    'nebula.field.lastSeen': 'Last seen',
    'nebula.field.testParameters': 'Test parameters',
    'nebula.field.assetCount': 'Assets: {count}',
    'nebula.field.sessionCount': 'Sessions: {count}',
    'nebula.field.target': 'Target',
    'nebula.field.hostKey': 'Host key',
    'nebula.field.serviceHost': 'Internal service',
    'nebula.field.host': 'Host',
    'nebula.field.severity': 'Severity',
    'nebula.field.vulnType': 'Vuln type',
    'nebula.field.targetUrl': 'Target URL',
    'nebula.field.vulnId': 'Vuln ID',
    'nebula.field.createdAt': 'Discovered',
    'nebula.field.reproduction': 'Reproduction preview',
    'nebula.field.relatedVulns': 'Related vulnerabilities',
    'nebula.field.infoType': 'Leak type',
    'nebula.field.value': 'Value',
    'nebula.field.source': 'Source',
    'nebula.field.impact': 'Potential impact',
    'nebula.field.session': 'Session',
    'nebula.field.phase': 'Current phase',
    'nebula.field.targetHosts': 'Target hosts',
    'nebula.field.nextSteps': 'Next steps',
    'nebula.field.unfinishedTasks': 'Unfinished tasks',
    'nebula.field.parentSession': 'Parent session',
    'nebula.field.updatedAt': 'Updated',
    'nebula.field.nodeId': 'Node ID',
    'nebula.field.weight': 'Weight',
    'nebula.field.none': 'None',

    // Empty / degraded states
    'nebula.empty.title': 'No nodes in this scope',
    'nebula.empty.description': 'Try another scope, or re-enable node types.',
    'nebula.empty.filteredTitle': 'Filters hide every node',
    'nebula.empty.filteredDescription':
      'Vulnerabilities, leaks and snapshots are all hidden — only hosts remain. Re-enable any type to see the full nebula.',
    'nebula.empty.resetFilters': 'Reset filters',
    'nebula.empty.noMatchTitle': 'No matching nodes',
    'nebula.empty.noMatchDescription':
      'Search only highlights — it never removes nodes. Try another keyword.',
    'nebula.empty.clearSearch': 'Clear search',
    'nebula.loading': 'Loading the nebula…',
    'nebula.canvas.ariaLabel':
      'Interactive 3D memory nebula: drag to rotate, scroll to zoom, click a node to inspect',

    // Safety / limits
    'nebula.truncated': 'Nebula truncated to the first {count} nodes',
    'nebula.performance.title': 'Large graph — rendering quality reduced',
    'nebula.performance.description':
      '{nodes} nodes and {links} links right now. Use type filters when you pass {limit}, or switch to the All scope for aggregated nodes.',
    'nebula.webglUnavailable.title': '3D rendering unavailable',
    'nebula.webglUnavailable.description':
      'WebGL is unavailable in this browser or GPU. Update the browser, enable hardware acceleration, or use the desktop app.',

    // P2 live data: builder limits, refresh, real scope targets
    'nebula.badge.live': 'Live data',
    'nebula.limits.hint': 'Limits: {hosts} hosts · {vulns} vulns · {leaks} leaks · {snapshots} snapshots',
    'nebula.refresh': 'Refresh data',
    'nebula.refreshAria': 'Reload the nebula from the database',
    'nebula.loading.graph': 'Loading the nebula from the database…',
    'nebula.error.title': 'Could not load the graph',
    'nebula.error.retry': 'Retry',
    'nebula.truncated.banner':
      'Graph limit reached — partial data: {hosts} hosts / {vulns} vulns / {leaks} leaks / {snapshots} snapshots',
    'nebula.unresolved': '{count} snapshot target hosts have no matching asset',
    'nebula.scope.hostLabel': 'Select asset',
    'nebula.scope.selectPlaceholder': 'Select…',
    'nebula.scope.sessionLabel': 'Select task',
    'nebula.scope.includeChildren': 'Include child sessions',
    'nebula.scope.assetEmpty': 'No assets in this database yet',
    'nebula.scope.taskEmpty': 'No snapshots in this database yet',
    'nebula.empty.databaseTitle': 'The database has no graph data yet',
    'nebula.empty.databaseDescription':
      'Once the agent records assets, vulnerabilities or snapshots, the nebula appears here.',
    'nebula.empty.assetTargetTitle': 'Pick an asset first',
    'nebula.empty.assetTargetDescription': 'Choose the asset to focus in the selector above.',
    'nebula.empty.taskTargetTitle': 'Pick a task first',
    'nebula.empty.taskTargetDescription':
      'Choose the snapshot session to focus in the selector above.',

    // P3 experience: focus neighbourhood, performance mode, fullscreen, export
    'nebula.focus.label': 'Focus neighbourhood',
    'nebula.focus.toggle': 'Highlight only the selected node neighborhood',
    'nebula.focus.depth1': '1 hop',
    'nebula.focus.depth2': '2 hops',
    'nebula.focus.hintSelect': 'Select a node to highlight its neighborhood',
    'nebula.focus.active': 'Focused on {count} nodes',
    'nebula.performance.mode': 'Performance mode: idle labels and halos are off',
    'nebula.fullscreen.enter': 'Fullscreen',
    'nebula.fullscreen.exit': 'Exit fullscreen',
    'nebula.export.png': 'Export PNG',
    'nebula.export.success': 'PNG exported',
    'nebula.export.failed': 'Export failed: the canvas is unavailable',
    'nebula.webglLost.title': '3D context lost',
    'nebula.webglLost.description':
      'The browser released the WebGL context (usually memory pressure or a long background tab). Try to restore it, or reload the page.',
    'nebula.webglLost.restore': 'Reload',
    'nebula.webglLost.retry': 'Try to restore',

    // P3 aggregation
    'nebula.aggregate.countLabel': 'Records',
    'nebula.aggregate.severityLabel': 'Highest severity',
    'nebula.aggregate.samplesLabel': 'Sample records',
    'nebula.aggregate.hint':
      'On large graphs several records of one host collapse into one +N node. Focus that host or switch to the asset scope to inspect individual records.',
    'nebula.legend.aggregate': '+N = aggregated nodes (click to inspect)',
    'nebula.mode2d.label': '2D fallback view (WebGL is unavailable here)',

    // Summary drawer → full detail pages
    'nebula.detail.openVuln': 'Open in vulnerabilities',
    'nebula.detail.openAsset': 'Open in assets',
    'nebula.detail.openSnapshot': 'Open in snapshots',
    'nebula.inspector.relatedCount': '{count} related vulnerabilities',
    'nebula.inspector.relationsMore': '{count} more relations',

    // J.A.R.V.I.S. tactical HUD chrome (all uppercase/mono in the UI)
    'nebula.hud.brand': 'CORTEX // NEBULA',
    'nebula.hud.subtitleOnline': 'SYSTEM ONLINE · TARGET LOCKED',
    'nebula.hud.subtitleLoading': 'SYSTEM SYNCING · PULLING GRAPH DATA',
    'nebula.hud.subtitleError': 'SYSTEM OFFLINE · DATA UNAVAILABLE',
    'nebula.hud.subtitleDegraded': 'SYSTEM DEGRADED · DATA TRUNCATED',
    'nebula.hud.system': 'SYSTEM',
    'nebula.hud.statHosts': 'HOSTS',
    'nebula.hud.statVulns': 'VULNS',
    'nebula.hud.statLeaks': 'LEAKS',
    'nebula.hud.statSnapshots': 'SNAPSHOTS',
    'nebula.hud.statCritical': 'CRITICAL',
    'nebula.hud.statNodes': 'NODES',
    'nebula.hud.statLinks': 'LINKS',
    'nebula.hud.scopeLabel': 'SCOPE',
    'nebula.hud.updated': 'UPDATED {time}',
    'nebula.hud.updatedNone': 'UPDATED —',
    'nebula.hud.shortcuts': 'NAV',
    'nebula.hud.drag': 'ROTATE',
    'nebula.hud.wheel': 'ZOOM',
    'nebula.hud.click': 'INSPECT',
    'nebula.hud.esc': 'CLOSE',
    'nebula.hud.modePerformance': 'PERF MODE',
    'nebula.hud.mode2d': '2D FALLBACK',
    'nebula.hud.labels': 'LABELS {visible}/{total}',
    'nebula.hud.panelControl': 'CONTROL',
    'nebula.hud.panelLegend': 'LEGEND',
    'nebula.hud.panelInspector': 'INSPECTOR',
    'nebula.hud.liveFeed': 'LIVE FEED',
    'nebula.hud.targetLocked': 'TARGET LOCKED',
    'nebula.hud.dataSource': 'SOURCE /api/graph',
    'nebula.hud.reducedMotion': 'MOTION REDUCED',
    'nebula.hud.noData': 'NO DATA',
    'nebula.hud.legendNodes': 'NODE TYPES',
    'nebula.hud.legendRelations': 'RELATIONS',
    'nebula.inspector.identity': 'IDENTITY',
    'nebula.inspector.network': 'RELATION NETWORK',
    'nebula.inspector.metrics': 'KEY METRICS',

    // Projected HUD label summaries (short node labels, follow zh/en)
    'nebula.label.leakSummary': '{type} leak'
  }
}
