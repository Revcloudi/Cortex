import type { MessageBundle } from './types'

/**
 * Standalone Web Fuzzer page chrome.
 *
 * The page no longer links to a finding, so the old `fuzzer.target.*` keys are
 * gone. Request/response controls reuse the `retest.repeater.*` keys; this
 * bundle only carries fuzzer-specific labels and validation hints.
 */
export const fuzzerMessages: MessageBundle = {
  zh: {
    'fuzzer.page.description':
      'Yakit 风格的手动发包页面：左侧编辑原始 HTTP 请求、右侧查看响应，支持原始 / JSON / 渲染三种视图；目标地址由主进程独立校验，不依赖漏洞记录。',
    'fuzzer.request.paneAria': '请求编辑与发送',
    'fuzzer.response.aria': '响应查看面板',
    'fuzzer.request.placeholder':
      'GET https://example.com/ HTTP/1.1\nHost: example.com\nAccept: */*',
    'fuzzer.request.invalidHint':
      '请求无法解析：请检查请求行（如 GET /api HTTP/1.1）与请求头格式；可解析后发送按钮会启用。',
    'fuzzer.request.urlRequired':
      '目标 URL 必须是绝对地址（以 http:// 或 https:// 开头）。',
    'fuzzer.request.methodUnsupported': '不支持的请求方法：{method}'
  },
  en: {
    'fuzzer.page.description':
      'Yakit-style manual HTTP sender: edit the raw request on the left and inspect the response on the right, with raw / JSON / render views. The Host validates the target independently and no finding is required.',
    'fuzzer.request.paneAria': 'Request editor and send controls',
    'fuzzer.response.aria': 'Response viewer',
    'fuzzer.request.placeholder':
      'GET https://example.com/ HTTP/1.1\nHost: example.com\nAccept: */*',
    'fuzzer.request.invalidHint':
      'Cannot parse the request: check the request line (e.g. GET /api HTTP/1.1) and headers. Send is enabled once it parses.',
    'fuzzer.request.urlRequired':
      'The request URL must be absolute (start with http:// or https://).',
    'fuzzer.request.methodUnsupported': 'Unsupported request method: {method}'
  }
}
