import { VulnerabilitySchema, type Vulnerability } from '../../shared/types'
import { DEMO_VULNERABILITY } from './demoVulnerability'

function at(now: Date, daysAgo: number, hour: number, minute = 0): string {
  const date = new Date(now)
  date.setDate(date.getDate() - daysAgo)
  date.setHours(hour, minute, 0, 0)
  return date.toISOString()
}

function idFor(createdAt: string, sequence: number): string {
  const date = new Date(createdAt)
  const year = date.getFullYear().toString().padStart(4, '0')
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  return `VULN-${year}${month}${day}-${sequence.toString().padStart(3, '0')}`
}

/**
 * Realistic fixtures used by the load-sample-data action and the capture
 * scripts. They are plain data: the app never scans anything.
 */
export function createDemoVulnerabilities(now: Date = new Date()): Vulnerability[] {
  const today = at(now, 0, 11, 42)
  const today2 = at(now, 0, 9, 18)
  const yesterday = at(now, 1, 16, 5)
  const threeDaysAgo = at(now, 3, 15, 30)
  const fiveDaysAgo = at(now, 5, 10, 12)
  const eightDaysAgo = at(now, 8, 17, 46)
  const twoDaysAgo = at(now, 2, 14, 22)
  const fourDaysAgo = at(now, 4, 10, 35)
  const sixDaysAgo = at(now, 6, 20, 10)
  const sevenDaysAgo = at(now, 7, 8, 48)
  const nineDaysAgo = at(now, 9, 13, 5)
  const tenDaysAgo = at(now, 10, 21, 30)

  const sqliId = idFor(today, 1)
  const ssrfId = idFor(today, 2)
  const jwtId = idFor(yesterday, 3)
  const idorId = idFor(threeDaysAgo, 4)
  const infoId = idFor(fiveDaysAgo, 5)
  const corsId = idFor(eightDaysAgo, 6)
  const xssId = idFor(twoDaysAgo, 7)
  const graphqlId = idFor(fourDaysAgo, 8)
  const gitId = idFor(sixDaysAgo, 9)
  const tlsId = idFor(sevenDaysAgo, 10)
  const exportId = idFor(nineDaysAgo, 11)
  const uploadId = idFor(tenDaysAgo, 12)

  const demoVulnerability = VulnerabilitySchema.parse({
    ...DEMO_VULNERABILITY,
    created_at: at(now, 0, 12, 5),
    status: 'Retest_Passed',
    retest_results: [
      {
        time_range: '2026-01-02 10:12–10:16（Asia/Shanghai）',
        conclusion: `### 复测结论

- **结果**：漏洞仍可复现。
- **关键证据**：未携带会话凭据的请求返回 HTTP 200，响应仍包含 OSS 预签名下载地址。

**复测请求**
\`\`\`http
GET /api/v1/files/download?file_id=10 HTTP/1.1
Host: opcenter.example.com
\`\`\`

**判据**：请求未携带 Cookie / Authorization，响应仍返回 200 与可下载地址。`
      },
      {
        time_range: '2026-01-02 11:03–11:07（Asia/Shanghai）',
        conclusion: `### 复测结论

- **结论**：仍未修复。
- **补充观察**：更换 \`file_id\` 后同样可取得预签名地址，说明不是单条记录缓存。

> 建议复测时继续使用只读方式，避免批量下载。`
      }
    ]
  })

  return [
    demoVulnerability,
    {
      id: sqliId,      host: '10.0.0.5:8080',
      entry_point: '/login',
      vuln_name: '登录接口 SQL 注入（UNION 回显）',
      vuln_type: 'SQLi',
      severity: 'Critical',
      target_url: 'http://10.0.0.5:8080/api/login',
      description:
        '登录接口 username 参数未参数化，直接拼接进 SQL 查询。布尔条件可改变响应长度，UNION 注入可在 users 表中直接读取管理员口令哈希。',
      impact:
        '未授权攻击者可绕过登录并导出全部用户数据；结合已泄露的 JWT 密钥可进一步接管任意账户。',
      affected_interfaces: ['/api/login', '/api/user/export', '/api/admin/audit-log'],
      reproduction_steps: '',
      remediation: [
        '登录接口改用预编译语句（PreparedStatement），禁止拼接用户输入。',
        '数据库账号降权为仅 SELECT/INSERT 业务表，禁用 FILE 与堆叠查询。',
        '统一返回体不携带口令哈希等敏感字段，错误信息对外模糊化。',
        '为登录接口增加基于 IP + 账号的限速与异常 SQL 关键字审计。'
      ],
      crypto_details: '',
      test_boundaries: '仅验证了 UNION 回显与布尔条件，未测试 WAF 绕过、盲注耗时与堆叠注入。',
      related_vuln_ids: [],
      status: 'Confirmed',
      created_at: today
    },
    {
      id: ssrfId,
      host: '10.0.0.5:8080',
      entry_point: '/api/proxy',
      vuln_name: '代理接口 SSRF 直连云元数据服务',
      vuln_type: 'SSRF',
      severity: 'High',
      target_url:
        'http://10.0.0.5:8080/api/proxy?url=http://169.254.169.254/latest/meta-data/',
      description:
        'URL 代理接口仅校验 URL 语法，未限制内网地址与重定向目标，可访问云主机元数据服务。',
      impact: '可读取实例 IAM 临时凭证，进而横向接管云账号下的其他资源。',
      affected_interfaces: ['/api/proxy', '/api/thumbnail'],
      reproduction_steps: '',
      remediation: [
        '对代理目标做 allowlist 域名校验，并在 DNS 解析后再次校验 IP 是否属于内网段。',
        '禁用跟随重定向，或对每一跳重定向目标重复执行 SSRF 校验。',
        '云主机启用 IMDSv2 并限制 role 权限，元数据端点加 hop limit。',
        '代理请求使用独立出口与最小权限身份。'
      ],
      crypto_details: '',
      test_boundaries: '未尝试通过 DNS rebinding 绕过 allowlist；未验证 IMDSv2 下是否仍可利用。',
      related_vuln_ids: [sqliId],
      status: 'Retest_Passed',
      created_at: today2
    },
    {
      id: jwtId,
      host: '192.168.1.10:8443',
      entry_point: '/admin',
      vuln_name: 'JWT 密钥硬编码导致管理员身份伪造',
      vuln_type: 'Auth_Bypass',
      severity: 'High',
      target_url: 'https://192.168.1.10:8443/admin',
      description:
        '前端 JS bundle 中硬编码了 HS256 签名密钥，攻击者可自行签发 role=admin 的 JWT，直接访问管理后台。',
      impact: '无需任何账号即可获得管理后台完全控制权，可审批提现、修改费率与导出商户数据。',
      affected_interfaces: ['/admin', '/api/admin/merchants', '/api/admin/settings'],
      reproduction_steps: '',
      remediation: [
        'JWT 密钥仅保存在服务端密钥管理系统，前端代码中不得出现任何签名材料。',
        '轮换全部现有密钥并强制所有会话重新登录。',
        '服务端校验 alg 白名单，拒绝 none 与客户端指定算法。',
        '管理接口增加二次鉴权（如 MFA）与敏感操作审计。'
      ],
      crypto_details: `算法：HS256（HMAC-SHA256）。
密钥来源：/static/js/app.8f3c.js 中硬编码的 JWT_SECRET="s3cr3t-hub-key-2026"。
签名流程：Base64Url(header).Base64Url(payload) 经 HS256 与泄露密钥计算 HMAC，输出签名。
复现要点：payload 中 role 改为 admin，exp 设为远期时间，其他字段保持与正常 token 一致。`,
      test_boundaries: '仅验证读取型管理接口，未对写操作（提现、改费率）执行实际变更。',
      related_vuln_ids: [],
      status: 'Confirmed',
      created_at: yesterday
    },
    {
      id: idorId,
      host: '192.168.1.10:8443',
      entry_point: '/api/v1/users/me',
      vuln_name: '用户资料接口越权访问（IDOR）',
      vuln_type: 'IDOR',
      severity: 'Medium',
      target_url: 'https://192.168.1.10:8443/api/v1/users/1002',
      description:
        '用户详情接口仅依据路径中的 uid 查询数据，未校验 uid 与当前登录会话的归属关系。',
      impact: '普通用户可遍历读取他人手机号、邮箱与收货地址等 PII 数据。',
      affected_interfaces: ['/api/v1/users/:uid', '/api/v1/orders?uid='],
      reproduction_steps: '',
      remediation: [
        '服务端从会话中取 uid，忽略或强校验路径中的 uid 参数。',
        '对返回字段做数据最小化，脱敏手机号、邮箱与地址。',
        '增加越权访问频率监控与告警。'
      ],
      crypto_details: '',
      test_boundaries: '仅遍历了 3 个相邻 uid，未批量导出全部用户数据。',
      related_vuln_ids: [jwtId],
      status: 'Inconclusive',
      created_at: threeDaysAgo
    },
    {
      id: infoId,
      host: 'api.acme-lab.internal:3000',
      entry_point: '/debug/env',
      vuln_name: '调试端点未鉴权泄露环境变量',
      vuln_type: 'Info_Disclosure',
      severity: 'Low',
      target_url: 'http://api.acme-lab.internal:3000/debug/env',
      description: '调试路由在生产环境未关闭且无鉴权，直接输出进程环境变量。',
      impact: '泄露数据库连接串、第三方 API Key 与内部服务地址，为后续攻击提供情报。',
      affected_interfaces: ['/debug/env', '/debug/config'],
      reproduction_steps: '',
      remediation: [
        '生产构建中移除调试路由或加管理员鉴权。',
        '轮换已泄露的 API Key 与数据库密码。'
      ],
      crypto_details: '',
      test_boundaries: '仅记录泄露字段类型，未尝试连接泄露的数据库。',
      related_vuln_ids: [],
      status: 'Confirmed',
      created_at: fiveDaysAgo
    },
    {
      id: corsId,
      host: '10.0.0.5:8080',
      entry_point: '/api/account',
      vuln_name: 'CORS 配置错误导致跨站读取账户信息',
      vuln_type: 'CORS_Misconfig',
      severity: 'Medium',
      target_url: 'http://10.0.0.5:8080/api/account',
      description: '接口回显任意 Origin 且允许携带凭证，任意站点可代表受害者读取账户信息。',
      impact: '攻击者可在恶意页面静默读取受害者账户余额、订单与地址。',
      affected_interfaces: ['/api/account', '/api/orders'],
      reproduction_steps: '',
      remediation: [
        'CORS 改为固定 allowlist，禁止回显请求 Origin。',
        '敏感接口增加 CSRF token 与 SameSite 校验作为纵深防御。'
      ],
      crypto_details: '',
      test_boundaries: '未搭建恶意页面验证浏览器端实际读取，仅通过响应头与响应体确认。',
      related_vuln_ids: [idorId],
      status: 'Retest_Passed',
      created_at: eightDaysAgo
    },
    {
      id: xssId,
      host: '10.0.0.5:8080',
      entry_point: '/api/feedback',
      vuln_name: '反馈接口存储型 XSS 可劫持管理员会话',
      vuln_type: 'XSS',
      severity: 'Medium',
      target_url: 'http://10.0.0.5:8080/api/feedback',
      description:
        '反馈内容接口把用户提交的 content 原样存入数据库并在管理后台列表页以 innerHTML 渲染，未做任何转义。',
      impact: '普通员工提交恶意反馈后，管理员打开反馈列表即触发脚本，可窃取后台会话并调用导出接口。',
      affected_interfaces: ['/api/feedback', '/admin/feedback/list'],
      reproduction_steps:
        '### 步骤 1：提交带脚本的反馈\n\n**请求**\n```http\nPOST /api/feedback HTTP/1.1\nHost: 10.0.0.5:8080\nContent-Type: application/json\n\n{"content":"<img src=x onerror=alert(document.cookie)>"}\n```\n\n**判据**：反馈创建成功，管理员端列表页加载时执行 onerror 中的脚本。',
      remediation: [
        '输出到富文本/HTML 上下文时按上下文转义，管理后台禁用 innerHTML 拼接。',
        '增加 CSP 限制内联脚本，并对用户提交内容做白名单过滤。'
      ],
      crypto_details: '',
      test_boundaries: '仅在测试账号上提交弹窗 PoC，未实际外传 Cookie。',
      related_vuln_ids: [sqliId],
      status: 'Confirmed',
      created_at: twoDaysAgo
    },
    {
      id: graphqlId,
      host: 'api.acme-lab.internal:3000',
      entry_point: '/graphql',
      vuln_name: 'GraphQL 内省未关闭泄露全部 schema',
      vuln_type: 'Info_Disclosure',
      severity: 'Info',
      target_url: 'http://api.acme-lab.internal:3000/graphql',
      description: '生产 GraphQL 端点未关闭 introspection，匿名请求即可拉取全部类型、字段与变更入口。',
      impact: '攻击者无需鉴权即可枚举后台数据模型与写操作，为越权与批量数据导出提供地图。',
      affected_interfaces: ['/graphql'],
      reproduction_steps:
        '### 步骤 1：发送内省查询\n\n**请求**\n```http\nPOST /graphql HTTP/1.1\nHost: api.acme-lab.internal:3000\nContent-Type: application/json\n\n{"query":"{__schema{types{name fields{name}}}}"}\n```\n\n**判据**：未携带 Authorization 仍返回 HTTP 200 与完整 schema。',
      remediation: ['生产环境关闭 introspection，或仅对管理员令牌开放。', '对 GraphQL 查询深度与复杂度做限制。'],
      crypto_details: '',
      test_boundaries: '仅读取 schema，未调用任何 mutation。',
      related_vuln_ids: [infoId],
      status: 'Confirmed',
      created_at: fourDaysAgo
    },
    {
      id: gitId,
      host: '192.168.1.10:8443',
      entry_point: '/.git/config',
      vuln_name: '生产环境 .git 目录暴露导致源码泄露',
      vuln_type: 'Info_Disclosure',
      severity: 'High',
      target_url: 'https://192.168.1.10:8443/.git/config',
      description: 'Web 根目录误部署 .git 目录且静态服务未拦截点文件，可完整还原前端源码与历史提交。',
      impact: '源码中硬编码的 JWT 密钥、内网地址与测试账号可被直接提取，为进一步攻击提供凭据。',
      affected_interfaces: ['/.git/HEAD', '/.git/config', '/.git/objects/'],
      reproduction_steps:
        '### 步骤 1：读取 git 配置\n\n**请求**\n```http\nGET /.git/config HTTP/1.1\nHost: 192.168.1.10:8443\n```\n\n**判据**：返回 200 且内容包含 [core] repositoryformatversion，可配合 git-dumper 还原仓库。',
      remediation: ['部署产物中排除 .git 等版本控制目录。', '静态服务拦截以点开头的敏感路径，并轮换已泄露密钥。'],
      crypto_details: '',
      test_boundaries: '仅验证 .git/config 与 HEAD 可读，未全量还原仓库。',
      related_vuln_ids: [jwtId],
      status: 'Retest_Passed',
      created_at: sixDaysAgo
    },
    {
      id: tlsId,
      host: 'mail.acme-lab.internal:8443',
      entry_point: '/',
      vuln_name: '邮件网关支持 TLS 1.0 与弱加密套件',
      vuln_type: 'Weak_TLS',
      severity: 'Low',
      target_url: 'https://mail.acme-lab.internal:8443/',
      description: '管理端口仍启用 TLS 1.0/1.1 与 3DES、RC4 套件，且证书为自签名。',
      impact: '中间人可降级协商弱套件，配合自签名证书存在会话解密风险。',
      affected_interfaces: ['/:443', '/:8443'],
      reproduction_steps:
        '### 步骤 1：手工握手枚举协议版本\n\n**请求**\n```http\nGET / HTTP/1.1\nHost: mail.acme-lab.internal:8443\n```\n\n**判据**：TLS 1.0 握手仍返回 200，且证书为自签名（issuer 与 subject 相同、与域名不匹配）。',
      remediation: ['禁用 TLS 1.0/1.1 与 3DES/RC4，仅保留 TLS 1.2+ 的 AEAD 套件。', '替换为受信任 CA 签发的证书并开启 HSTS。'],
      crypto_details: '协商套件：TLS_RSA_WITH_3DES_EDE_CBC_SHA；证书签名算法 SHA256-RSA 自签名。',
      test_boundaries: '仅做握手枚举，未尝试实际中间人解密。',
      related_vuln_ids: [],
      status: 'Confirmed',
      created_at: sevenDaysAgo
    },
    {
      id: exportId,
      host: 'opcenter.example.com:443',
      entry_point: '/api/v1/admin/export',
      vuln_name: '管理端导出接口缺少权限校验（IDOR）',
      vuln_type: 'IDOR',
      severity: 'Critical',
      target_url: 'https://opcenter.example.com/api/v1/admin/export?scope=all',
      description: '导出接口只校验登录态，未校验角色与 scope 参数归属，普通学生账号可指定 scope=all 导出全量班级数据。',
      impact: '任意注册用户可以导出全部院校、班级与学生 PII，属于大规模数据泄露。',
      affected_interfaces: ['/api/v1/admin/export', '/api/v1/admin/export'],
      reproduction_steps:
        '### 步骤 1：使用学生账号请求全量导出\n\n**请求**\n```http\nGET /api/v1/admin/export?scope=all HTTP/1.1\nHost: opcenter.example.com\nCookie: SESSION=student-session\n```\n\n**判据**：返回 200，data 中班级数量与管理员账号一致，证明越权生效。',
      remediation: ['导出接口增加角色校验，scope 由服务端从会话推导而非客户端传入。', '为批量导出增加审计与频率限制。'],
      crypto_details: '',
      test_boundaries: '为避免下载大量 PII，仅比对返回的班级数量字段，未保存导出文件。',
      related_vuln_ids: [],
      status: 'Inconclusive',
      created_at: nineDaysAgo
    },
    {
      id: uploadId,
      host: '192.168.1.10:8443',
      entry_point: '/api/v1/upload',
      vuln_name: '上传接口未校验文件类型可上传 JSP Webshell',
      vuln_type: 'File_Upload',
      severity: 'High',
      target_url: 'https://192.168.1.10:8443/api/v1/upload',
      description: '附件上传接口仅校验 Content-Type，未校验扩展名与文件内容，且上传目录可被静态服务解析。',
      impact: '攻击者可上传 JSP 文件并访问执行，获得应用服务器权限。',
      affected_interfaces: ['/api/v1/upload', '/uploads/'],
      reproduction_steps:
        '### 步骤 1：上传伪装的 JSP 文件\n\n**请求**\n```http\nPOST /api/v1/upload HTTP/1.1\nHost: 192.168.1.10:8443\nContent-Type: multipart/form-data; boundary=----demo\n\n------demo\nContent-Disposition: form-data; name="file"; filename="avatar.jsp"\nContent-Type: image/png\n\n<% out.print(1+1); %>\n------demo--\n```\n\n**判据**：返回 200 且 data.url 指向 /uploads/avatar.jsp，访问后页面输出 2。',
      remediation: ['按扩展名与文件内容双重校验，上传目录禁用脚本解析。', '文件重命名存储到对象存储，并通过下载代理返回。'],
      crypto_details: '',
      test_boundaries: '仅上传输出 1+1 的验证文件，未部署持久化后门。',
      related_vuln_ids: [jwtId],
      status: 'Retest_Passed',
      created_at: tenDaysAgo
    }
  ].map((vuln) => VulnerabilitySchema.parse(vuln))
}
