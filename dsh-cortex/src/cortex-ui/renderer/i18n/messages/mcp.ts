import type { MessageBundle } from './types'

/** MCP Access page: transport card, database card, agent snippets, tool table. */
export const mcpMessages: MessageBundle = {
  zh: {
    // Page header
    'mcp.page.eyebrow': 'MCP 接入 · stdio',
    'mcp.page.title': 'MCP 接入',
    'mcp.page.subtitle': 'Agent 直连本地 SQLite',
    'mcp.page.description':
      '桌面端不启动任何 MCP 服务；Agent 用 stdio 拉起 MCP server，两边读写同一份本地数据库。',

    // Runtime mode badge
    'mcp.mode.installed': '安装版',
    'mcp.mode.development': '开发模式',

    // stdio transport card
    'mcp.stdio.title': 'stdio 接入',
    'mcp.stdio.transport': '传输：stdio（由 Agent 启动，无需启动 GUI）',
    'mcp.stdio.note':
      'Agent 在自己的进程里拉起 MCP server，通过 stdin/stdout 交换 JSON-RPC；应用不监听端口，也不存在「服务是否在线」的中间状态。',
    'mcp.stdio.launchCommand': '启动命令',
    'mcp.stdio.loadingCommand': '正在读取 MCP 运行信息…',
    'mcp.stdio.copyCommand': '复制 stdio 启动命令',
    'mcp.stdio.copiedCommand': '已复制启动命令',
    'mcp.stat.transport': '传输协议',
    'mcp.stat.toolCount': '工具数量',
    'mcp.stat.toolCountValue': '{count} 个',
    'mcp.stat.appVersion': '应用版本',

    // Local database card
    'mcp.database.title': '本地数据库',
    'mcp.database.description':
      '文件信息在打开本页时读取一次；数据变更由主进程文件监听推送（data:changed），其他页面会自动刷新。',
    'mcp.database.file': '数据库文件',
    'mcp.database.schemaVersion': 'schema v{version}',
    'mcp.database.mainSize': '主库大小',
    'mcp.database.walSize': 'WAL 大小',
    'mcp.database.lastModified': '最后修改',
    'mcp.database.fileStatus': '文件状态',
    'mcp.database.created': '已创建',
    'mcp.database.notCreated': '尚未创建',
    'mcp.database.readError': '读取数据库信息失败：{error}',
    'mcp.database.footerPrefix': '数据库文件',
    'mcp.database.footerSuffix': '· 桌面端与 Agent 共享同一份本地数据，不经过任何云端服务。',

    // Agent install snippets
    'mcp.agents.loadingHeading': 'Agent 接入',
    'mcp.agents.loadingDescription': '客户端配置片段会在这里按 Agent 列出。',
    'mcp.agents.loadingNote':
      '正在读取 MCP 运行信息…如果这里一直没有出现片段，请确认应用运行在 Electron 客户端中。',
    'mcp.agents.title': 'Agent 接入',
    'mcp.agents.description':
      '把片段写入对应客户端并重启 Agent；MCP server 由 Agent 自己以 stdio 拉起，桌面端无需保持运行。',
    'mcp.agents.clients': '{count} 个客户端',
    'mcp.agents.configLocation': '配置位置',
    'mcp.agents.copyToast': '已复制 {name} 配置',

    // Tool reference table
    'mcp.tools.title': 'MCP 工具',
    'mcp.tools.description': 'Agent 通过以下工具读写漏洞记录，参数均经 zod 严格校验。',
    'mcp.tools.count': '{count} 个工具',
    'mcp.tools.caption': 'MCP 工具列表',
    'mcp.tools.columnTool': '工具',
    'mcp.tools.columnPurpose': '用途',
    'mcp.tools.columnInput': '输入',
    'mcp.tools.columnReturns': '返回'
  },
  en: {
    // Page header
    'mcp.page.eyebrow': 'MCP Access · stdio',
    'mcp.page.title': 'MCP Access',
    'mcp.page.subtitle': 'Direct agent access to local SQLite',
    'mcp.page.description':
      'The desktop app runs no MCP service. The agent launches the MCP server over stdio, and both sides read and write the same local database.',

    // Runtime mode badge
    'mcp.mode.installed': 'Installed',
    'mcp.mode.development': 'Development',

    // stdio transport card
    'mcp.stdio.title': 'stdio transport',
    'mcp.stdio.transport': 'Transport: stdio (launched by the agent; no GUI required)',
    'mcp.stdio.note':
      'The agent launches the MCP server inside its own process and exchanges JSON-RPC over stdin/stdout. The app listens on no port, so there is no "service online" state to check.',
    'mcp.stdio.launchCommand': 'Launch command',
    'mcp.stdio.loadingCommand': 'Reading MCP runtime info…',
    'mcp.stdio.copyCommand': 'Copy stdio launch command',
    'mcp.stdio.copiedCommand': 'Launch command copied',
    'mcp.stat.transport': 'Transport',
    'mcp.stat.toolCount': 'Tools',
    'mcp.stat.toolCountValue': '{count} tools',
    'mcp.stat.appVersion': 'App version',

    // Local database card
    'mcp.database.title': 'Local database',
    'mcp.database.description':
      'File metadata is read once when this page opens; data changes are pushed by the main-process file watcher (data:changed) and other pages refresh automatically.',
    'mcp.database.file': 'Database file',
    'mcp.database.schemaVersion': 'schema v{version}',
    'mcp.database.mainSize': 'Main DB size',
    'mcp.database.walSize': 'WAL size',
    'mcp.database.lastModified': 'Last modified',
    'mcp.database.fileStatus': 'File status',
    'mcp.database.created': 'Created',
    'mcp.database.notCreated': 'Not created yet',
    'mcp.database.readError': 'Failed to read database info: {error}',
    'mcp.database.footerPrefix': 'Database file',
    'mcp.database.footerSuffix':
      '· The desktop app and the agent share the same local data; no cloud service is involved.',

    // Agent install snippets
    'mcp.agents.loadingHeading': 'Agent setup',
    'mcp.agents.loadingDescription': 'Client config snippets are listed here per agent.',
    'mcp.agents.loadingNote':
      'Reading MCP runtime info… If no snippets ever appear, make sure the app is running inside the Electron client.',
    'mcp.agents.title': 'Agent setup',
    'mcp.agents.description':
      'Write the snippet into the matching client and restart the agent. The agent launches the MCP server over stdio, so the desktop app does not need to stay open.',
    'mcp.agents.clients': '{count} clients',
    'mcp.agents.configLocation': 'Config location',
    'mcp.agents.copyToast': 'Copied {name} config',

    // Tool reference table
    'mcp.tools.title': 'MCP tools',
    'mcp.tools.description':
      'The agent reads and writes vulnerability records through these tools; every parameter is strictly validated by zod.',
    'mcp.tools.count': '{count} tools',
    'mcp.tools.caption': 'MCP tool list',
    'mcp.tools.columnTool': 'Tool',
    'mcp.tools.columnPurpose': 'Purpose',
    'mcp.tools.columnInput': 'Input',
    'mcp.tools.columnReturns': 'Returns'
  }
}
