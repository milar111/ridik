/**
 * Getting a document out of the app.
 *
 * Four different native modules, four different ways to be unavailable: no
 * share sheet on a locked-down device, no mail account configured, no printing
 * service on an Android build. Every entry point returns a `Result` and none of
 * them throws, because "I could not export that" is a sentence the app has to
 * be able to say calmly while the user is standing in a corridor.
 */
import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import * as MailComposer from 'expo-mail-composer';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { createLogger } from '@/core/logger';
import { fail, ok, toAppError, type Result } from '@/core/result';

import { markdownToHtml } from './markdown';

const log = createLogger('export');

export type ShareOutcome = {
  /** `file://` URI of the document that was written. */
  uri: string;
  /** Whether the share sheet actually opened. */
  shared: boolean;
};

export type EmailOutcome = {
  /** `mail` when a composer opened, `share` when we fell back to the share sheet. */
  method: 'mail' | 'share';
  status?: MailComposer.MailComposerStatus;
  uri?: string;
};

export type ExportPdfOptions = { share?: boolean };
export type EmailOptions = { recipients?: string[]; filename?: string };

/**
 * Anything that could walk out of the cache directory, plus the characters
 * Android's media scanner and iOS' share sheet both dislike.
 */
function safeFilename(name: string, fallbackExtension: string): string {
  const base = name
    .replace(/[/\\]/g, ' ')
     
    .replace(/[\u0000-\u001f:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const cleaned = base.replace(/^\.+/, '').trim() || 'ridik-export';
  return /\.[a-z0-9]{1,5}$/i.test(cleaned) ? cleaned : `${cleaned}.${fallbackExtension}`;
}

function writeCacheFile(filename: string, contents: string): File {
  const file = new File(Paths.cache, filename);
  // `create` throws on an existing path unless told otherwise, and an export
  // repeated twice in a row is the normal case, not the exception.
  file.create({ overwrite: true, intermediates: true });
  file.write(contents);
  return file;
}

async function canShare(): Promise<boolean> {
  try {
    return await Sharing.isAvailableAsync();
  } catch (error) {
    log.warn('could not query the share sheet', error);
    return false;
  }
}

export async function copyToClipboard(markdown: string): Promise<Result<void>> {
  try {
    const copied = await Clipboard.setStringAsync(markdown);
    if (!copied) return fail('unsupported', 'I could not reach the clipboard.');
    return ok(undefined);
  } catch (error) {
    const appError = toAppError(error, 'I could not copy that.');
    log.warn('clipboard write failed', appError);
    return fail('unsupported', 'I could not copy that.', { cause: appError });
  }
}

/**
 * Writes a text document into the cache directory and offers it to the share
 * sheet.
 *
 * Markdown by default because that is what almost every caller has. The two
 * type hints are options rather than a second function: a `.json` export handed
 * out under `net.daringfireball.markdown` is offered to the wrong apps on iOS
 * and refused by the right ones, and the fix is two strings, not a second
 * file-writing path to keep in step with this one.
 */
export async function shareAsFile(
  markdown: string,
  filename: string,
  options: { dialogTitle?: string; mimeType?: string; uti?: string } = {},
): Promise<Result<ShareOutcome>> {
  let uri: string;
  try {
    uri = writeCacheFile(safeFilename(filename, 'md'), markdown).uri;
  } catch (error) {
    const appError = toAppError(error, 'I could not write that file.');
    log.error('export write failed', appError);
    return fail('unknown', 'I could not write that file.', { cause: appError });
  }

  if (!(await canShare())) {
    // The document exists; only the hand-off is missing, and the caller may
    // still want the URI (to attach it to a mail, say).
    return fail('unsupported', 'Sharing is not available on this device.', { details: { uri } });
  }

  try {
    await Sharing.shareAsync(uri, {
      mimeType: options.mimeType ?? 'text/markdown',
      UTI: options.uti ?? 'net.daringfireball.markdown',
      dialogTitle: options.dialogTitle ?? 'Share export',
    });
    return ok({ uri, shared: true });
  } catch (error) {
    const appError = toAppError(error, 'I could not open the share sheet.');
    log.warn('share failed', appError);
    return fail('unknown', 'I could not open the share sheet.', {
      cause: appError,
      details: { uri },
    });
  }
}

/** Renders the markdown to simple styled HTML and prints it to a PDF. */
export async function exportPdf(
  markdown: string,
  title: string,
  options: ExportPdfOptions = {},
): Promise<Result<ShareOutcome>> {
  let uri: string;
  try {
    const printed = await Print.printToFileAsync({ html: markdownToHtml(markdown, { title }) });
    uri = printed.uri;
  } catch (error) {
    const appError = toAppError(error, 'I could not make a PDF of that.');
    log.error('pdf export failed', appError);
    return fail('unsupported', 'I could not make a PDF of that.', { cause: appError });
  }

  if (options.share === false || !(await canShare())) return ok({ uri, shared: false });

  try {
    await Sharing.shareAsync(uri, {
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
      dialogTitle: title,
    });
    return ok({ uri, shared: true });
  } catch (error) {
    // The PDF is on disk and its URI is useful, so a refused share sheet is a
    // partial success rather than a failure.
    log.warn('could not share the PDF', toAppError(error));
    return ok({ uri, shared: false });
  }
}

/**
 * Opens a mail composer with the document as the body and as an attachment.
 * A device with no mail account falls back to the share sheet rather than
 * dead-ending, which is the common case on a school-issued Android tablet.
 */
export async function emailSummary(
  markdown: string,
  subject: string,
  options: EmailOptions = {},
): Promise<Result<EmailOutcome>> {
  const filename = safeFilename(options.filename ?? subject, 'md');

  let available = false;
  try {
    available = await MailComposer.isAvailableAsync();
  } catch (error) {
    log.warn('could not query the mail composer', error);
  }

  if (!available) {
    const shared = await shareAsFile(markdown, filename, { dialogTitle: subject });
    if (!shared.ok) {
      return fail('unsupported', 'There is no mail app set up on this device.', {
        cause: shared.error,
      });
    }
    return ok({ method: 'share', uri: shared.value.uri });
  }

  // An attachment that cannot be written must not cost the user the email.
  let uri: string | undefined;
  try {
    uri = writeCacheFile(filename, markdown).uri;
  } catch (error) {
    log.warn('could not attach the export', error);
  }

  try {
    const result = await MailComposer.composeAsync({
      recipients: options.recipients,
      subject,
      body: markdown,
      isHtml: false,
      ...(uri ? { attachments: [uri] } : {}),
    });
    return ok({ method: 'mail', status: result.status, uri });
  } catch (error) {
    const appError = toAppError(error, 'I could not open your mail app.');
    log.warn('mail compose failed', appError);
    return fail('unknown', 'I could not open your mail app.', { cause: appError, details: { uri } });
  }
}
