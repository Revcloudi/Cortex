import { z } from 'zod'
import {
  ASSET_STATUSES,
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
    /** 1-based page number; the database clamps it to the last page. */
    page: z.number().int().min(1).max(100_000).optional(),
    /** Rows per page; the UI only offers 10 / 20 / 50, the db caps at 200. */
    pageSize: z.number().int().min(1).max(200).optional()
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

export const SnapshotSessionIdIpcSchema = z.string().trim().min(1).max(100)

/** Desktop-only archive toggle (Agent has no archive action). */
export const SnapshotArchiveIpcSchema = z
  .object({
    sessionId: SnapshotSessionIdIpcSchema,
    archived: z.boolean()
  })
  .strict()

/** Mirrors `AgentId` in `src/shared/types.ts` (type-only there, runtime list here). */
export const SETUP_AGENT_IDS = ['dsh', 'codex', 'claude', 'cursor'] as const

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

