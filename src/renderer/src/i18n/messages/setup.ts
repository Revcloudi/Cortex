import type { MessageBundle } from './types'

export const setupMessages: MessageBundle = {
  zh: {
    'setup.title': '欢迎使用 Cortex',
    'setup.description':
      '选择要接入的 Agent，并决定安装中文还是英文 Skill。之后可在侧边栏随时切换界面语言。',
    'setup.agentsTitle': '接入 Agent',
    'setup.agentsHint': '仅勾选你实际使用的客户端；未检测到的客户端也可以勾选，之后按其配置文件路径写入。',
    'setup.agent.dsh': 'DeepSeek Harness',
    'setup.agent.codex': 'Codex CLI',
    'setup.agent.claude': 'Claude Code',
    'setup.agent.cursor': 'Cursor',
    'setup.detected': '已检测到',
    'setup.notDetected': '未检测到',
    'setup.skillLanguageTitle': 'Skill 语言',
    'setup.skillLanguageHint': '安装到 Agent 的 vuln-db / asset-context / snapshot Skill 使用该语言。',
    'setup.skillZh': '中文 Skill',
    'setup.skillEn': 'English Skill',
    'setup.apply': '初始化并写入配置',
    'setup.applying': '正在写入配置…',
    'setup.skip': '稍后设置',
    'setup.noAgents': '请至少选择一个 Agent，或点击「稍后设置」。',
    'setup.failed': '初始化失败，请检查 Agent 配置目录权限后重试。',
    'setup.success': '配置写入完成',
    'setup.successHint': '重启对应 Agent 后生效；也可以随时在「MCP 接入」页查看配置片段。',
    'setup.close': '完成',
    'setup.manualRequired': '需手动处理',
    'setup.loading': '正在检测本机 Agent…'
  },
  en: {
    'setup.title': 'Welcome to Cortex',
    'setup.description':
      'Choose which agents to connect and whether to install Chinese or English skills. You can switch the UI language from the sidebar at any time.',
    'setup.agentsTitle': 'Agents',
    'setup.agentsHint':
      'Select the clients you actually use. Undetected clients can still be selected; Cortex writes their config files by path.',
    'setup.agent.dsh': 'DeepSeek Harness',
    'setup.agent.codex': 'Codex CLI',
    'setup.agent.claude': 'Claude Code',
    'setup.agent.cursor': 'Cursor',
    'setup.detected': 'detected',
    'setup.notDetected': 'not detected',
    'setup.skillLanguageTitle': 'Skill language',
    'setup.skillLanguageHint':
      'The vuln-db / asset-context / snapshot skills installed into the agents use this language.',
    'setup.skillZh': 'Chinese skills',
    'setup.skillEn': 'English skills',
    'setup.apply': 'Initialize and write configs',
    'setup.applying': 'Writing configuration…',
    'setup.skip': 'Set up later',
    'setup.noAgents': 'Select at least one agent, or choose "Set up later".',
    'setup.failed': 'Setup failed. Check permissions on the agent config directories and retry.',
    'setup.success': 'Configuration written',
    'setup.successHint':
      'Restart the selected agents to apply. The exact snippets are always available on the MCP Access page.',
    'setup.close': 'Done',
    'setup.manualRequired': 'manual action required',
    'setup.loading': 'Detecting local agents…'
  }
}
