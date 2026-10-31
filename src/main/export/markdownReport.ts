/**
 * Compatibility re-export.
 *
 * The report template moved to `src/shared/markdownReport.ts` so the Web server
 * (`src/server`) can render the exact same Markdown without importing Electron
 * main-process code. Existing desktop imports keep working unchanged.
 */
export { buildReportFilename, buildVulnerabilityReportMarkdown } from '../../shared/markdownReport'
