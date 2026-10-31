import { AssetContextSchema, type AssetContext } from '../../shared/types'

/**
 * Demo asset contexts used by the seeded dashboard/capture flow. They line up
 * with the demo vulnerability hosts so the asset drawer's relation tab is
 * immediately useful: 10.0.0.5:8080 is an exact match, while
 * opcenter.example.com is intentionally recorded without a port to exercise the
 * host-only → host:port fallback.
 *
 * Interfaces are structured (`path` + optional `method` / `params` / raw
 * `request`) to exercise the asset drawer's method badges, parameter display and
 * raw-request copy path. One path-only entry is kept so the legacy
 * `interface_dir`-style payload stays covered.
 */
export function createDemoAssets(now: Date = new Date()): AssetContext[] {
  const lastSeen = now.toISOString()

  return [
    AssetContextSchema.parse({
      host_port: 'https://opcenter.example.com/login',
      host: 'opcenter.example.com',
      project_name: '示例云课堂',
      tech_stack: 'Nginx 1.24, Spring Boot 3.2；Vue 3、OSS 对象存储',
      auth_required: false,
      status: 'Alive',
      interfaces: [
        {
          path: '/api/v1/files/download',
          method: 'GET',
          params: 'file_id=10',
          request: [
            'GET /api/v1/files/download?file_id=10 HTTP/1.1',
            'Host: opcenter.example.com',
            'Accept: application/json, text/plain, */*',
            'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0',
            '',
            ''
          ].join('\r\n')
        },
        {
          path: '/api/v1/team/projects',
          method: 'GET',
          params: 'class_id=1&page=1&page_size=20'
        },
        {
          path: '/api/v1/user/info',
          method: 'GET'
        },
        {
          path: '/api/v1/admin/login',
          method: 'POST',
          params: '{"username":"admin","password":"Example-Passw0rd!"}',
          request: [
            'POST /api/v1/admin/login HTTP/1.1',
            'Host: opcenter.example.com',
            'Content-Type: application/json;charset=UTF-8',
            'Content-Length: 43',
            '',
            '{"username":"admin","password":"Example-Passw0rd!"}'
          ].join('\r\n')
        },
        {
          path: '/api/v1/admin/export'
        }
      ],
      leaked_infos: [
        {
          info_type: 'API_Key',
          value: 'LTAI5tFakeExampleKey000000',          source: 'https://static.example.com/assets/prod/index-abc123.chunk.js:182',
          potential_impact: '疑似阿里云 STS 临时凭证的 AK，可用于调用 OSS/STS API 枚举或接管存储桶'
        },
        {
          info_type: 'Token',
          value:
            'FAKE_JWT_TOKEN_EXAMPLE',
          source:
            'https://static.example.com/assets/prod/index-abc123.components.chunk.js:1487',
          potential_impact:
            '硬编码在构建产物中的学生端 JWT，exp 已过期但密钥仍在包内；重新签发 role=admin 的令牌即可接管管理接口，并可复用于同域 OSS 预签名链路'
        },
        {
          info_type: 'Internal_IP',
          value: '10.0.0.25',
          source: 'https://static.example.com/app.123abc.js:904',
          potential_impact: '内网地址可能对应管理后台或数据库代理，用于横向移动与内网探测'
        },
        {
          info_type: 'Other',
          value:
            'https://files.oss.example.com/example-bucket%2Fsample-group.rar?Expires=1761895200&OSSAccessKeyId=LTAI5tFakeExampleKey000000&Signature=FAKE_SIGNATURE',
          source:
            'https://opcenter.example.com/api/v1/files/download?file_id=10 响应 data.file_url',
          potential_impact:
            '匿名接口直接下发的 OSS 预签名下载地址，file_id 可枚举，可在有效期内批量读取学生团队作业与学生姓名'
        }
      ],
      test_parameters: [
        {
          name: 'class_id',
          endpoint:
            'GET /api/v1/team/projects?class_id={class_id}',
          location: 'query',
          values: ['1', '2', '10'],
          pattern: '班级 id 自增（1~60），与下载接口 file_id 同一空间',
          source: '学生端项目列表请求参数与响应 data[].class_id',
          tested: false,
          notes: '用于验证班级团队项目越权读取；只取 3 个样例，避免遍历全量班级',
          related_vuln_ids: ['VULN-20260101-001']
        }
      ],
      related_vuln_ids: ['VULN-20260101-001'],
      last_seen: lastSeen
    }),
    AssetContextSchema.parse({
      host_port: 'http://10.0.0.5:8080/login',
      host: '10.0.0.5',
      project_name: '内部资产管理系统',
      tech_stack: 'Spring Boot 3.2；Tomcat 10、MySQL 8, Nginx 1.24',
      auth_required: true,
      status: 'Alive',
      interfaces: [
        {
          path: '/api/login',
          method: 'POST',
          params: '{"username":"admin","password":"Example-Passw0rd!"}',
          request: [
            'POST /api/login HTTP/1.1',
            'Host: 10.0.0.5:8080',
            'Content-Type: application/json',
            'Content-Length: 45',
            '',
            '{"username":"admin","password":"Example-Passw0rd!"}'
          ].join('\r\n')
        },
        {
          path: '/api/user/export',
          method: 'GET',
          params: 'page=1&size=500&dept_id=all'
        },
        {
          path: '/api/admin/users',
          method: 'GET'
        },
        {
          path: '/api/proxy/fetch',
          method: 'POST',
          params: '{"url":"http://169.254.169.254/latest/meta-data/"}',
          request: [
            'POST /api/proxy/fetch HTTP/1.1',
            'Host: 10.0.0.5:8080',
            'Content-Type: application/json',
            'Cookie: SESSION=5f1c2a9e7b3d4f60',
            '',
            '{"url":"http://169.254.169.254/latest/meta-data/iam/security-credentials/"}'
          ].join('\r\n')
        },
        {
          path: '/api/team/project/download',
          method: 'GET',
          params: 'project_id=42'
        }
      ],
      leaked_infos: [
        {
          info_type: 'Credential',
          value: 'admin / Example-Passw0rd!',
          source: 'https://10.0.0.5:8080/static/js/app.8e1f.js:417',
          potential_impact: '疑似管理员账号，可用于登录后台并访问用户导出接口'
        },
        {
          info_type: 'Token',
          value:
            'grafana_sa_token_eyJhbGciOiJSUzI1NiIsImtpZCI6IjhmM2M5YTJiMWQ0ZTZmNzA4MTkyYTNiNGM1ZDZlN2Y4In0.eyJzdWIiOiJzZXJ2aWNlYWNjb3VudDpncmFmYW5hOjEwIiwicm9sZSI6IkFkbWluIiwiaWF0IjoxNzYxODg4MDAwfQ.c2lnbmF0dXJlLThmM2M5YTJiMWQ0ZTZmNzA4MTkyYTNiNGM1ZDZlN2Y4',
          source: 'https://10.0.0.5:8080/static/js/monitor.3b7e1d.js:2088',
          potential_impact:
            '监控面板 Grafana Admin Service Account Token，可直接读取全量主机与业务指标，结合泄露的数据库连接串可进一步定位生产库'
        }
      ],
      test_parameters: [
        {
          name: 'id',
          endpoint: 'GET /api/user/export?id={id}',
          location: 'query',
          values: ['10001', '10002', '10003'],
          pattern: '用户 id 自增（10000+），导出响应 data[].id 连续',
          source: 'GET /api/user/export?page=1&size=500 响应 data[].id',
          tested: false,
          notes: '只取 3 个样例做越权验证，避免批量导出真实用户 PII',
          related_vuln_ids: []
        },
        {
          name: 'orderId',
          endpoint: 'GET /api/v1/orders/{orderId}',
          location: 'path',
          values: ['ORD-20260101-0001', 'ORD-20260101-0002'],
          pattern: 'ORD-YYYYMMDD-NNNN，日期段与流水号可枚举',
          source: '订单列表页 URL 与响应 data[].orderId',
          tested: true,
          notes: '已用相邻 orderId 验证 IDOR，结论见漏洞库越权记录',
          related_vuln_ids: []
        }
      ],
      related_vuln_ids: [],
      last_seen: lastSeen
    }),
    AssetContextSchema.parse({
      host_port: 'https://192.168.1.10:8443/login',
      host: '192.168.1.10',
      project_name: '员工门户',
      tech_stack: 'Vue 3、Vite 5；Nginx 1.25, Cloudflare',
      auth_required: true,
      status: 'WAF_Blocked',
      interfaces: [
        {
          path: '/api/v1/users/me',
          method: 'GET'
        },
        {
          path: '/api/v1/admin/audit',
          method: 'GET',
          params: 'page=1&limit=100&action=export'
        },
        {
          path: '/api/v1/admin/merchants',
          method: 'PATCH',
          params: '{"merchant_id":"M-1002","fee_rate":0.006}',
          request: [
            'PATCH /api/v1/admin/merchants HTTP/1.1',
            'Host: 192.168.1.10:8443',
            'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYWRtaW4ifQ.demo-signature',
            'Content-Type: application/json',
            '',
            '{"merchant_id":"M-1002","fee_rate":0.006}'
          ].join('\r\n')
        },
        {
          path: '/download/report',
          method: 'POST',
          params: '{"report_id":"2026-01","format":"xlsx"}'
        }
      ],
      leaked_infos: [
        {
          info_type: 'Token',
          value:
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTc2MTg4ODAwMCwiZXhwIjo0MTAyNDQ0ODAwfQ.demo-signature',
          source: 'https://portal.example.internal/assets/index-2f9d.js:1204',
          potential_impact: '无签名校验的 JWT 可能被伪造为管理员，用于越权访问审计接口'
        }
      ],
      related_vuln_ids: [],
      last_seen: lastSeen
    })
  ]
}
