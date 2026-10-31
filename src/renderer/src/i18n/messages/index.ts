import type { MessageBundle } from './types'
import { assetMessages } from './asset'
import { commonMessages } from './common'
import { dashboardMessages } from './dashboard'
import { mcpMessages } from './mcp'
import { setupMessages } from './setup'
import { snapshotMessages } from './snapshot'
import { uiMessages } from './ui'
import { vulnMessages } from './vuln'

export type { MessageBundle } from './types'

const bundles: MessageBundle[] = [
  commonMessages,
  uiMessages,
  dashboardMessages,
  vulnMessages,
  assetMessages,
  snapshotMessages,
  mcpMessages,
  setupMessages
]

function mergeBundles(lang: 'zh' | 'en'): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const bundle of bundles) Object.assign(merged, bundle[lang])
  return merged
}

export const messages: Record<'zh' | 'en', Record<string, string>> = {
  zh: mergeBundles('zh'),
  en: mergeBundles('en')
}
