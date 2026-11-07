import type { MessageBundle } from './types'
import { assetMessages } from './asset'
import { commonMessages } from './common'
import { dashboardMessages } from './dashboard'
import { fuzzerMessages } from './fuzzer'
import { internalMessages } from './internal'
import { mcpMessages } from './mcp'
import { miniappMessages } from './miniapp'
import { nebulaMessages } from './nebula'
import { retestMessages } from './retest'
import { snapshotMessages } from './snapshot'
import { uiMessages } from './ui'
import { vulnMessages } from './vuln'

export type { MessageBundle } from './types'

const bundles: MessageBundle[] = [
  commonMessages,
  uiMessages,
  dashboardMessages,
  internalMessages,
  vulnMessages,
  assetMessages,
  snapshotMessages,
  nebulaMessages,
  mcpMessages,
  retestMessages,
  miniappMessages,
  fuzzerMessages
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
