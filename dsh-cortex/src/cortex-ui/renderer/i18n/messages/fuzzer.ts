import type { MessageBundle } from './types'

/**
 * Web Fuzzer page chrome (manual Yakit-style sender).
 *
 * The request/response controls reuse the existing `retest.repeater.*` keys, so
 * only the page-level target selector needs its own bundle.
 */
export const fuzzerMessages: MessageBundle = {
  zh: {
    'fuzzer.page.description':
      'Yakit 风格的手动发包页面：左侧编辑请求、右侧查看响应；请求仍受目标漏洞 origin 白名单约束。',
    'fuzzer.target.title': '目标漏洞',
    'fuzzer.target.select': '选择目标漏洞',
    'fuzzer.target.empty': '没有可用的 Web 漏洞',
    'fuzzer.target.loadFailed': '无法加载 Web 漏洞：{error}',
    'fuzzer.target.detailFailed': '无法加载漏洞详情',
    'fuzzer.request.paneAria': '请求编辑与发送',
    'fuzzer.response.aria': '响应查看面板'
  },
  en: {
    'fuzzer.page.description':
      'Yakit-style manual HTTP sender: edit the request on the left and inspect the response on the right. Every request is still constrained by the target finding origin allowlist.',
    'fuzzer.target.title': 'Target finding',
    'fuzzer.target.select': 'Select target finding',
    'fuzzer.target.empty': 'No Web findings available',
    'fuzzer.target.loadFailed': 'Cannot load Web findings: {error}',
    'fuzzer.target.detailFailed': 'Cannot load the finding details',
    'fuzzer.request.paneAria': 'Request editor and send controls',
    'fuzzer.response.aria': 'Response viewer'
  }
}
