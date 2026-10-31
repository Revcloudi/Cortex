import { SnapshotPayloadSchema, type SnapshotPayload } from '../../shared/types'
import { createDemoVulnerabilities } from './demoVulns'

/**
 * One demo project session with two child (system) sessions.
 *
 * `archived` marks the child that the seed archives, so the desktop UI can show
 * an archived sub-session without any extra setup.
 */
export interface DemoSnapshotChild {
  payload: SnapshotPayload
  archived: boolean
}

export interface DemoSnapshotSet {
  project: SnapshotPayload
  children: DemoSnapshotChild[]
}

/**
 * Demo cognitive snapshots used by the load-sample-data flow.
 *
 * The fixture mirrors the bundled demo vulnerabilities / assets: one campaign
 * session (a demo group SRC project) hangs two system sub-sessions (portal + ticket
 * system), and one of the children ships archived so the archive state is
 * visible immediately. `seedDemoData` creates the hierarchy and performs one
 * partial update on the project session so the single-step rollback button
 * (`previous_state`) is also visible in screenshots.
 *
 * `related_vuln_ids` reference ids of the bundled demo vulnerabilities generated
 * with the same `now`, so every reference really exists in the seeded
 * vulnerability library. The project notes carry a compact scope ledger
 * (filed / excluded / pending verification) instead of duplicating detailed
 * evidence.
 */
export function createDemoSnapshots(now: Date = new Date()): DemoSnapshotSet {
  const demoVulns = createDemoVulnerabilities(now)
  const idsForHost = (host: string, limit = 3): string[] =>
    demoVulns
      .filter((vuln) => vuln.host === host)
      .map((vuln) => vuln.id)
      .slice(0, limit)
  const portalVulnIds = idsForHost('192.168.1.10:8443', 4)
  const ticketVulnIds = idsForHost('10.0.0.5:8080', 4)
  const campaignVulnIds = [...new Set([...portalVulnIds, ...ticketVulnIds])]

  const project = SnapshotPayloadSchema.parse({
    project_name: '某集团 SRC 项目',
    target_hosts: ['192.168.1.10:8443', '10.0.0.5:8080'],
    current_phase: '资产范围梳理完成，门户系统已确认 4 类问题，工单系统 SSRF 待复测',
    unfinished_tasks: [
      '门户系统：用泄露的 JWT 密钥伪造 admin 访问 /admin/merchants（只读）',
      '工单系统：复测 /api/proxy/fetch SSRF 是否仍可读取云元数据凭证',
      '汇总两个子系统的证据，统一导出 SRC 报告'
    ],
    failed_paths: [
      '门户系统 /api/v1/admin/settings 写操作被审计拦截，暂不继续',
      '工单系统 sqlmap 全量扫描被限速，改为手工验证'
    ],
    tested_interfaces: [
      {
        target: 'GET /api/scope/list',
        method: '按集团资产清单核对系统入口与负责人',
        result: '确认 2 个在范围内系统：门户 192.168.1.10:8443、工单 10.0.0.5:8080'
      },
      {
        target: 'GET https://portal.example/robots.txt（仅指纹确认）',
        method: '被动指纹与证书 SAN 核对',
        result: '与资产清单一致，无新增未报备系统'
      }
    ],
    notes: `## 范围台账（紧凑）

**已入库系统**
- 集团门户系统：\`192.168.1.10:8443\`（JWT 硬编码、IDOR、.git 泄露、上传）
- 工单系统：\`10.0.0.5:8080\`（SQLi、SSRF、CORS、存储型 XSS）

**已排除目标**
- 邮件网关 \`mail.acme-lab.internal:8443\`：仅 TLS 弱套件，非本次 SRC 范围
- 静态资源域：只做 JS 线索收集，不作为独立系统

**待验证**
- 门户后台 \`PATCH /admin/merchants\` 写操作（避免影响生产，仅只读验证）
- 工单系统 \`/api/user/export\` 全量导出（先取小范围样本）

> 详细 HTTP 报文与复现步骤写入漏洞库；接口与原始请求写入资产库；本快照只保留结论与 related_vuln_ids 引用。`,
    related_vuln_ids: campaignVulnIds,
    next_steps:
      '先完成两个子系统的只读复测并补齐证据，再统一汇总；阶段完成后更新项目会话并归档已完成子会话。'
  })

  const children: DemoSnapshotChild[] = [
    {
      archived: false,
      payload: SnapshotPayloadSchema.parse({
        project_name: '集团门户系统',
        target_hosts: ['192.168.1.10:8443'],
        current_phase: 'JWT 伪造与 .git 源码泄露已确认，IDOR 待补证据',
        unfinished_tasks: [
          '用泄露密钥签发 role=admin 的 JWT，只读访问 /admin 与 /api/admin/merchants',
          '确认 .git 目录可恢复范围，提取硬编码密钥清单',
          '补写 IDOR（/api/v1/users/:uid）的批量验证证据'
        ],
        failed_paths: [
          '/admin/settings PATCH 被二次鉴权拦截，未继续',
          '上传 JSP Webshell 在目标环境返回 403，疑似已修复'
        ],
        tested_interfaces: [
          {
            target: 'POST /admin',
            method: 'HS256 密钥硬编码，自行签发 role=admin JWT',
            result: '200，进入管理后台首页，确认身份伪造'
          },
          {
            target: 'GET /.git/config',
            method: '直接读取点文件',
            result: '200，可配合 git-dumper 还原仓库；已提取 JWT_SECRET'
          },
          {
            target: 'GET /api/v1/users/1002',
            method: '普通账号替换路径 uid',
            result: '200，返回他人 PII，确认 IDOR'
          }
        ],
        notes: `## 门户系统关键命令

\`\`\`bash
curl -s 'https://192.168.1.10:8443/api/v1/users/1002' \\
  -H 'Authorization: Bearer <普通用户 token>' | head -c 400
\`\`\`

- 普通账号即可读取他人手机号 / 邮箱，属于 IDOR。
- 前端 bundle 与 .git 中均发现 JWT_SECRET，签名流程见漏洞库记录。
- 完整请求/响应不回填快照，只用 related_vuln_ids 引用。`,
        related_vuln_ids: portalVulnIds,
        next_steps: '补齐 IDOR 批量验证与小范围证据截图，完成后归档该系统子会话。'
      })
    },
    {
      archived: true,
      payload: SnapshotPayloadSchema.parse({
        project_name: '工单系统',
        target_hosts: ['10.0.0.5:8080'],
        current_phase: 'SSRF 直连云元数据已确认，暂挂起等待客户授权复测',
        unfinished_tasks: [
          '读取 /latest/meta-data/iam/security-credentials/ 获取角色名（只读）',
          '复核 /api/user/export?dept_id=all 的越权范围',
          '验证 CORS 修复建议是否可被回显 Origin 绕过'
        ],
        failed_paths: [
          'sqlmap 全量扫描被 WAF 限速，改用单参数手工验证',
          '直接访问 169.254.169.254 被网络策略阻断，仅 SSRF 可完成'
        ],
        tested_interfaces: [
          {
            target: 'POST /api/proxy/fetch',
            method: 'body 传入 169.254.169.254 元数据地址',
            result: '200，返回实例角色信息，确认 SSRF'
          },
          {
            target: 'GET /api/account',
            method: '伪造 Origin 并携带 Cookie',
            result: '回显任意 Origin，确认 CORS 配置错误'
          },
          {
            target: 'POST /api/login',
            method: 'sqlmap 布尔/时间盲注（限速后 20 次）',
            result: '响应稳定无差异，疑似参数化查询，未确认'
          }
        ],
        notes: `## 工单系统观察

- SSRF 验证仅读取元数据角色名，**未**读取任何凭证内容。
- 客户要求暂停工单系统深度测试，等待授权；本会话先归档保留上下文。
- 恢复测试时先执行 list（含归档）→ load 本子会话，确认授权后再继续。`,
        related_vuln_ids: ticketVulnIds,
        next_steps: '等待客户授权后从归档恢复；先验证 SSRF，再补越权导出证据。'
      })
    }
  ]

  return { project, children }
}
