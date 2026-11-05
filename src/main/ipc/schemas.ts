import { z } from 'zod'
import {
  ASSET_STATUSES,
  REALM_FILTERS,
  SEVERITIES,
  VULN_STATUSES,
  isValidAssetIdentifier
} from '../../shared/types'

/**
 * IPC-only validation schemas (renderer -> main).
 *
 * Kept out of `src/shared/ipc.ts` on purpose: the preload bundle imports the
 * channel constants from that module and runs with `sandbox: true`, where it
 * cannot require third-party packages such as zod. Only `electron` may be
 * required by the preload script.
 */

export const GetVulnerabilityIpcSchema = z.string().trim().min(1).max(100)

export const DeleteVulnerabilityIpcSchema = z.string().trim().min(1).max(100)

export const UpdateStatusIpcSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    status: z.enum(VULN_STATUSES)
  })
  .strict()

export const ListVulnerabilitiesIpcSchema = z
  .object({
    search: z.string().max(500).optional(),
    severity: z.enum([...SEVERITIES, 'all']).optional(),
    status: z.enum([...VULN_STATUSES, 'all']).optional(),
    /** Realm isolation: the Web tab asks for `web`, the internal board for `internal`. */
    realm: z.enum(REALM_FILTERS).optional(),
    /** 1-based page number; the database clamps it to the last page. */
    page: z.number().int().min(1).max(100_000).optional(),
    /** Rows per page; the UI only offers 10 / 20 / 50, the db caps at 200. */
    pageSize: z.number().int().min(1).max(200).optional()
  })
  .strict()
  .optional()

/** Dashboard counters can be scoped to one realm (Web tab / internal board). */
export const DashboardStatsIpcSchema = z
  .object({
    realm: z.enum(REALM_FILTERS).optional()
  })
  .strict()
  .optional()

export const WriteClipboardIpcSchema = z.string().min(1).max(2_000_000)

/** Shared validation for multi-select delete / Markdown export. */
export const VulnerabilityIdsIpcSchema = z
  .array(z.string().trim().min(1).max(100))
  .min(1)
  .max(500)

export const AssetHostPortIpcSchema = z
  .string()
  .trim()
  .min(1, 'host_port is required')
  .max(4_000)
  .refine(
    isValidAssetIdentifier,
    'host_port must be a full URL (preferred), a host or host:port, without whitespace'
  )

export const ListAssetsIpcSchema = z
  .object({
    search: z.string().max(500).optional(),
    status: z.enum([...ASSET_STATUSES, 'all']).optional()
  })
  .strict()
  .optional()

export const ProjectNameIpcSchema = z.string().trim().min(1, 'project_name is required').max(120)

/** Compact cognitive-snapshot list filters (renderer -> main). */
export const ListSnapshotsIpcSchema = z
  .object({
    keyword: z.string().trim().max(200).optional(),
    /** Only root/project sessions. */
    rootsOnly: z.boolean().optional(),
    /** Only direct children of this project session. */
    parentSessionId: z.string().trim().min(1).max(100).optional(),
    /** Archived sessions are hidden by default. */
    includeArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional()
  })
  .strict()
  .optional()

/**
 * Read-only Memory Nebula graph query (guide §9.1).
 *
 * The asset scope reuses `AssetHostPortIpcSchema` so the desktop IPC bridge and
 * the Web route reject exactly the same malformed host_port values as
 * `getAssetDetail`; the task scope validates the snapshot `session_id` the same
 * way the snapshot APIs do. Every nested object is strict so a renderer typo
 * surfaces as a clear validation error instead of being silently ignored.
 */
const MemoryGraphScopeIpcSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z
    .object({
      kind: z.literal('asset'),
      hostPort: AssetHostPortIpcSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('task'),
      sessionId: z.string().trim().min(1).max(100),
      includeChildren: z.boolean().optional()
    })
    .strict()
])

export const MemoryGraphQueryIpcSchema = z
  .object({
    scope: MemoryGraphScopeIpcSchema,
    /** Logical realm filter (plan §7.2): web (default) / internal / all. */
    realm: z.enum(['web', 'internal', 'all']).optional(),
    /** Neighbourhood depth; the literal union keeps the `1 | 2` inferred type. */
    depth: z.union([z.literal(1), z.literal(2)]).optional(),
    /** Node-type switches forwarded to the builder (all types when omitted). */
    filters: z
      .object({
        vulnerabilities: z.boolean().optional(),
        leaks: z.boolean().optional(),
        snapshots: z.boolean().optional(),
        /** Include the internal layer in `all` scope. */
        internal: z.boolean().optional()
      })
      .strict()
      .optional(),
    /** Per-type row limits, clamped again by the builder (guide §9.4). */
    limits: z
      .object({
        hosts: z.number().int().min(1).max(500).optional(),
        vulnerabilities: z.number().int().min(1).max(2_000).optional(),
        leaks: z.number().int().min(1).max(1_000).optional(),
        snapshots: z.number().int().min(1).max(200).optional(),
        /** Internal operation limits (plan §7.2 / §12). */
        footholds: z.number().int().min(1).max(300).optional(),
        internalHosts: z.number().int().min(1).max(1_000).optional(),
        internalServices: z.number().int().min(1).max(3_000).optional()
      })
      .strict()
      .optional()
  })
  .strict()

export const SnapshotSessionIdIpcSchema = z.string().trim().min(1).max(100)

/** Desktop-only archive toggle (Agent has no archive action). */
export const SnapshotArchiveIpcSchema = z
  .object({
    sessionId: SnapshotSessionIdIpcSchema,
    archived: z.boolean()
  })
  .strict()

/** Mirrors `AgentId` in `src/shared/types.ts` (type-only there, runtime list here). */
export const SETUP_AGENT_IDS = ['dsh', 'codex', 'claude', 'cursor', 'workbuddy', 'zcode'] as const

/**
 * First-run setup request from the wizard: an explicit agent selection plus the
 * language for the copied skills and the renderer UI.
 */
export const SetupRunRequestIpcSchema = z
  .object({
    agents: z
      .array(z.enum(SETUP_AGENT_IDS))
      .min(1, 'Select at least one agent')
      .max(SETUP_AGENT_IDS.length),
    skillLanguage: z.enum(['zh', 'en']),
    uiLanguage: z.enum(['zh', 'en'])
  })
  .strict()

/**
 * Internal operations (Plan B) IPC inputs.
 *
 * The entity payload schemas (credential trial, loot import) live in
 * `src/shared/internal.ts` and are re-exported here so the desktop IPC bridge
 * and the Web routes validate exactly the same bodies. Only the renderer-facing
 * query wrappers are declared locally; every object is strict so a renderer
 * typo fails loudly instead of being silently ignored.
 */

/** `getInternalGraph`: the graph projection is always scoped to one project. */
export const InternalGraphQueryIpcSchema = z
  .object({ project_name: ProjectNameIpcSchema })
  .strict()

/** `{ project_name?: string }` filter shared by overview / loot list reads. */
const OptionalProjectFilterIpcSchema = z
  .object({ project_name: ProjectNameIpcSchema.optional() })
  .strict()

/** `getInternalOverview(input?)`: omit the filter to use the active project. */
export const InternalOverviewIpcSchema = OptionalProjectFilterIpcSchema.optional()

/** `listLootImports(input?)`: newest-first list, optionally scoped to a project. */
export const ListLootImportsIpcSchema = OptionalProjectFilterIpcSchema.optional()

/** `recordCredentialTrial`: no auto-attempt; the GUI only records a known outcome. */
export { RecordCredentialTrialInputSchema as RecordCredentialTrialIpcSchema } from '../../shared/internal'

/** `importLoot`: local file path only; the importer never executes the file. */
export { ImportLootInputSchema as ImportLootIpcSchema } from '../../shared/internal'

/* ------------------------------------------------------------------------- */
/* AI model config + retest repeater (desktop only)                          */
/* ------------------------------------------------------------------------- */

export { PocIdSchema as PocIdIpcSchema } from '../../shared/poc'

export {
  ListPocModelsInputSchema as ListPocModelsIpcSchema,
  SavePocConfigInputSchema as SavePocConfigIpcSchema,
  TestPocProviderInputSchema as TestPocProviderIpcSchema,
  UpsertPocProviderInputSchema as UpsertPocProviderIpcSchema
} from '../../shared/poc'

export { RepeaterSendInputSchema as RepeaterSendIpcSchema } from '../../shared/repeater'

