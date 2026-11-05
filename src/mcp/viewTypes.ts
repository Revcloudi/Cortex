/**
 * MCP-facing vulnerability projections.
 *
 * These types are deliberately *separate* from the GUI `Vulnerability` type in
 * `shared/types.ts`: they are explicit `Pick`s, so if a future schema change
 * ever adds a PoC field (`js_code`, `ui_schema`, …) to the GUI type, MCP can
 * never start returning it by accident. The runtime side is additionally
 * protected by `stripPocFields` in `./pocSanitize.ts` and by never joining the
 * `poc_artifacts` / `poc_runs` tables in MCP queries (design doc §11.5).
 */
import type {
  AssetContext,
  PaginatedVulnerabilities,
  Severity,
  VulnHostQueryResult,
  Vulnerability,
  VulnerabilityListItem,
  VulnStatus,
  VulnSummary
} from '../shared/types'

/** Full vulnerability record as returned by `query_vulnerabilities({ vuln_id })`. */
export type McpVulnerabilityView = Pick<
  Vulnerability,
  | 'id'
  | 'host'
  | 'service_host'
  | 'realm'
  | 'internal_service_id'
  | 'entry_point'
  | 'vuln_name'
  | 'vuln_type'
  | 'severity'
  | 'target_url'
  | 'description'
  | 'impact'
  | 'affected_interfaces'
  | 'reproduction_steps'
  | 'remediation'
  | 'crypto_details'
  | 'test_boundaries'
  | 'retest_results'
  | 'related_vuln_ids'
  | 'status'
  | 'created_at'
>

/** Compact row as returned by the paginated list branch. */
export type McpVulnerabilityListItemView = Pick<
  VulnerabilityListItem,
  | 'id'
  | 'host'
  | 'service_host'
  | 'realm'
  | 'internal_service_id'
  | 'entry_point'
  | 'vuln_name'
  | 'vuln_type'
  | 'severity'
  | 'target_url'
  | 'status'
  | 'created_at'
>

export interface McpVulnSummaryView {
  vuln_id: string
  vuln_name: string
  severity: Severity
  target_url: string
}

export interface McpVulnHostQueryResult {
  host: string
  total: number
  items: McpVulnSummaryView[]
}

export interface McpPaginatedVulnerabilitiesView {
  items: McpVulnerabilityListItemView[]
  total: number
  page: number
  pageSize: number
}

/** `query_asset_context` result is built from the assets table only. */
export type McpAssetContextView = AssetContext

/** Convert a full GUI row into the explicit MCP view (no spread, no extra keys). */
export function toMcpVulnerabilityView(vuln: Vulnerability): McpVulnerabilityView {
  return {
    id: vuln.id,
    host: vuln.host,
    service_host: vuln.service_host,
    realm: vuln.realm === 'internal' ? 'internal' : 'web',
    internal_service_id: vuln.internal_service_id,
    entry_point: vuln.entry_point,
    vuln_name: vuln.vuln_name,
    vuln_type: vuln.vuln_type,
    severity: vuln.severity,
    target_url: vuln.target_url,
    description: vuln.description,
    impact: vuln.impact,
    affected_interfaces: [...vuln.affected_interfaces],
    reproduction_steps: vuln.reproduction_steps,
    remediation: [...vuln.remediation],
    crypto_details: vuln.crypto_details,
    test_boundaries: vuln.test_boundaries,
    retest_results: vuln.retest_results.map((retest) => ({
      time_range: retest.time_range,
      conclusion: retest.conclusion
    })),
    related_vuln_ids: [...vuln.related_vuln_ids],
    status: vuln.status as VulnStatus,
    created_at: vuln.created_at
  }
}

/** Keep the unused-import checker honest about the contract re-exports. */
export type McpPaginatedSource = PaginatedVulnerabilities
export type McpHostQuerySource = VulnHostQueryResult
export type McpSummarySource = VulnSummary

/**
 * Compile-time guard: if a PoC field is ever added to the GUI `Vulnerability`
 * type AND accidentally included in `McpVulnerabilityView`, this assertion
 * fails the build. The runtime sanitizer is the second line of defence.
 */
type ForbiddenPocKey = 'js_code' | 'ui_schema' | 'ui_schema_json' | 'code_hash' | 'poc_artifacts' | 'poc_runs' | 'poc_artifact' | 'poc_run'
type LeakedViewKey = Extract<keyof McpVulnerabilityView | keyof McpVulnerabilityListItemView, ForbiddenPocKey>
const _assertNoPocKeysInMcpViews: LeakedViewKey extends never ? true : never = true
void _assertNoPocKeysInMcpViews
