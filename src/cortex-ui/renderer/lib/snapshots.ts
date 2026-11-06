import type {
  SnapshotSession,
  SnapshotSummary,
  SnapshotTestedInterface
} from '@shared/types'
import { snapshotMessages } from '@renderer/i18n/messages/snapshot'

/** Translator compatible with `useI18n().t`, injected so the brief follows the UI language. */
export type SnapshotTranslate = (
  key: string,
  params?: Record<string, string | number>
) => string

/** English fallback for callers that build the brief outside the React tree. */
function fallbackTranslate(key: string, params?: Record<string, string | number>): string {
  const template = snapshotMessages.en[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    params[name] === undefined ? `{${name}}` : String(params[name])
  )
}

/** Optional hierarchy context for the tactical brief. */
export interface SnapshotBriefOptions {
  /** Direct child sessions of a project/root session. */
  children?: readonly SnapshotSummary[]
  /** Project name when the brief is built for a child (system) session. */
  parentName?: string
  /** UI translator (`useI18n().t`); defaults to English when omitted. */
  t?: SnapshotTranslate
}

/** One Markdown bullet per task, or the explicit "none" marker for an empty list. */
function buildBullets(items: readonly string[], none: string): string {
  if (items.length === 0) return `- ${none}`
  return items.map((item) => `- ${item}`).join('\n')
}

function textOrPlaceholder(value: string, placeholder: string): string {
  return value.trim().length > 0 ? value.trim() : placeholder
}

/** Collapse line breaks so one record always stays on one Markdown bullet. */
function flattenLine(value: string): string {
  return value.replace(/\r?\n+/g, ' ').trim()
}

/**
 * Wrap a value in a Markdown inline-code span, choosing a backtick delimiter
 * longer than any backtick run in the value. This keeps payloads such as
 * `` `or 1=1` `` intact when another Markdown client renders the brief.
 */
function inlineCode(value: string): string {
  const text = flattenLine(value)
  const backtickRuns = text.match(/`+/g) ?? []
  const longestRun = backtickRuns.reduce((longest, run) => Math.max(longest, run.length), 0)
  const delimiter = '`'.repeat(longestRun + 1)
  const padding = longestRun > 0 ? ' ' : ''
  return `${delimiter}${padding}${text}${padding}${delimiter}`
}

/** Escape plain-text Markdown characters that would otherwise start a code span. */
function escapePlainText(value: string): string {
  return value.replace(/`/g, '\\`')
}

/**
 * One bullet for the interface test matrix, e.g.
 * ``- `POST /api/login` → 200 login succeeded``. The technique/payload summary
 * (`method`) is optional and rendered inside the same code span.
 */
function buildTestedInterfaceLine(iface: SnapshotTestedInterface, none: string): string {
  const method = flattenLine(iface.method)
  const target = flattenLine(iface.target)
  const result = flattenLine(iface.result)
  const label = inlineCode(method.length > 0 ? `${method} ${target}` : target)
  return result.length > 0
    ? `- ${label} → ${escapePlainText(result)}`
    : `- ${label} → ${none}`
}

function buildRelatedVulnLines(ids: readonly string[], none: string): string {
  if (ids.length === 0) return `- ${none}`
  return ids.map((id) => `- ${inlineCode(id)}`).join('\n')
}

/** One line per child session: project name, id, phase and last update. */
function buildChildSessionLines(
  children: readonly SnapshotSummary[],
  t: SnapshotTranslate
): string {
  return children
    .map((child) =>
      t('snapshot.brief.childLine', {
        project: child.project_name,
        id: child.session_id,
        phase: textOrPlaceholder(child.current_phase, t('snapshot.brief.notRecorded')),
        updated: child.updated_at
      })
    )
    .join('\n')
}

/**
 * Build the copy-paste tactical brief for one snapshot session.
 *
 * The Markdown is intentionally plain (no tables / HTML) so it can be pasted
 * into DSH, another agent session or a chat window without losing structure.
 * Every payload field is represented so the next session never loses context;
 * detailed evidence still lives in the vulnerability / asset libraries, and the
 * brief only carries their ids.
 *
 * Project sessions may pass their child sessions so the next agent can navigate
 * the project/system hierarchy; child sessions may pass `parentName` so the
 * project they belong to survives the copy.
 */
export function buildSnapshotBrief(
  session: SnapshotSession,
  options: SnapshotBriefOptions = {}
): string {
  const t = options.t ?? fallbackTranslate
  const notRecorded = t('snapshot.brief.notRecorded')
  const none = t('snapshot.brief.none')
  const hosts =
    session.target_hosts.length > 0 ? session.target_hosts.join(', ') : notRecorded
  const notes = session.notes.trim().length > 0 ? session.notes.trim() : none
  const testedInterfaces =
    session.tested_interfaces.length > 0
      ? session.tested_interfaces
          .map((iface) => buildTestedInterfaceLine(iface, none))
          .join('\n')
      : `- ${none}`
  const parentName = options.parentName?.trim() ?? ''
  const children = options.children ?? []
  const childLines = children.length > 0 ? buildChildSessionLines(children, t) : null

  const blocks: string[] = [t('snapshot.brief.title', { project: session.project_name }), '']

  blocks.push(t('snapshot.brief.session', { id: session.session_id }))
  if (parentName.length > 0) {
    blocks.push(t('snapshot.brief.parent', { project: parentName }))
  }
  blocks.push(
    t('snapshot.brief.phase', {
      phase: textOrPlaceholder(session.current_phase, notRecorded)
    }),
    t('snapshot.brief.targets', { hosts }),
    t('snapshot.brief.updatedAt', { time: session.updated_at })
  )
  if (session.archived_at !== null) {
    blocks.push(t('snapshot.brief.statusArchived'))
  }

  if (childLines !== null) {
    blocks.push('', t('snapshot.brief.childrenHeading'), childLines)
  }

  blocks.push(
    '',
    t('snapshot.brief.unfinishedHeading'),
    buildBullets(session.unfinished_tasks, none),
    '',
    t('snapshot.brief.failedHeading'),
    buildBullets(session.failed_paths, none),
    '',
    t('snapshot.brief.testedHeading'),
    testedInterfaces,
    '',
    t('snapshot.brief.relatedHeading'),
    buildRelatedVulnLines(session.related_vuln_ids, none),
    '',
    t('snapshot.brief.notesHeading'),
    notes,
    '',
    t('snapshot.brief.nextStepsHeading'),
    textOrPlaceholder(session.next_steps, notRecorded)
  )

  return blocks.join('\n')
}

/**
 * Client-side keyword filter for the session list.
 *
 * Matches project name, current phase, target hosts and the next-step excerpt
 * case-insensitively; an empty (or whitespace-only) keyword returns every row in
 * its original order.
 */
export function filterSnapshotSummaries(
  items: readonly SnapshotSummary[],
  keyword: string
): SnapshotSummary[] {
  const needle = keyword.trim().toLowerCase()
  if (needle.length === 0) return items.slice()

  return items.filter((item) => {
    if (
      item.project_name.toLowerCase().includes(needle) ||
      item.current_phase.toLowerCase().includes(needle) ||
      item.next_steps_excerpt.toLowerCase().includes(needle)
    ) {
      return true
    }
    return item.target_hosts.some((host) => host.toLowerCase().includes(needle))
  })
}
