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

/**
 * The backup: the same split again, and the pure half is the interesting one.
 * `json.ts` is where merge-not-replace is decided, documented and tested.
 */
export {
  applyImport,
  backupTables,
  buildBackup,
  countRows,
  describeImport,
  orderTables,
  parseBackup,
  planImport,
  serialiseBackup,
  BACKUP_FORMAT,
  BACKUP_VERSION,
} from './json';
export type {
  Backup,
  BackupRow,
  ImportPlan,
  ImportSummary,
  ImportVerdict,
  TablePlan,
} from './json';

export {
  backupFilename,
  deleteBackup,
  listBackups,
  pickBackup,
  readBackup,
  saveBackup,
  shareBackup,
} from './backup';
export type { BackupFileInfo, PickedBackup } from './backup';
