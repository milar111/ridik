/**
 * The export surface: pure document builders on one side, native delivery on
 * the other. Callers import from here so the split never leaks into a screen.
 */
export {
  briefingMarkdown,
  escapeHtml,
  escapeMarkdown,
  ledgerMarkdown,
  markdownToHtml,
  projectMarkdown,
  weeklyStandup,
} from './markdown';
export type { HtmlOptions, MarkdownOptions, StandupOptions } from './markdown';

export { copyToClipboard, emailSummary, exportPdf, shareAsFile } from './share';
export type { EmailOptions, EmailOutcome, ExportPdfOptions, ShareOutcome } from './share';
