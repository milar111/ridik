/**
 * Getting a backup off the phone, and getting one back on.
 *
 * The document itself is built and read by `json.ts`, which is pure. This is
 * the half that touches the filesystem: where a backup lives, how it reaches
 * the share sheet, and how a file the user chose is opened.
 *
 * Everything returns a `Result` and nothing throws, for the same reason
 * `share.ts` does not: "I could not write that" is a sentence the app has to be
 * able to say calmly, and a restore screen that crashes over a missing folder
 * is a restore screen nobody trusts with the one copy of their data.
 *
 * Backups are written into the **documents** directory rather than the cache.
 * A cache file is deletable by the OS the moment storage runs low, which is
 * precisely when somebody is about to need it; and the whole point of the
 * feature is that a backup made three weeks ago is still there after a mistaken
 * "Delete all data". They are also handed to the share sheet, because a copy
 * that only exists inside the app it is a backup of is not really a backup.
 */
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { now } from '@/core/clock';
import { createLogger } from '@/core/logger';
import { epochToLocal } from '@/core/time';
import { fail, ok, toAppError, type Result } from '@/core/result';

const log = createLogger('backup');

/** Kept in one folder so the list is a directory read, not a name filter. */
const FOLDER = 'backups';
const SUFFIX = '.json';

export type BackupFileInfo = {
  uri: string;
  name: string;
  bytes: number;
  /** Epoch ms. Falls back to the name's own stamp when the OS has no answer. */
  savedAt: number;
};

export function backupFilename(at = now()): string {
  return `ridik-${epochToLocal(at).toFormat('yyyy-LL-dd-HHmm')}${SUFFIX}`;
}

function folder(): Directory {
  return new Directory(Paths.document, FOLDER);
}

function ensureFolder(): Directory {
  const directory = folder();
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

function describe(file: File): BackupFileInfo {
  return {
    uri: file.uri,
    name: file.name,
    bytes: file.size ?? 0,
    // `modificationTime` is null on some Android versions for files the app
    // itself wrote; the creation time and then the clock are the fallbacks.
    savedAt: file.modificationTime ?? file.creationTime ?? 0,
  };
}

/** Writes one backup and returns where it went. */
export function saveBackup(json: string, at = now()): Result<BackupFileInfo> {
  try {
    const file = new File(ensureFolder(), backupFilename(at));
    // An export repeated inside the same minute is a normal thing to do, not
    // an error worth showing anybody.
    file.create({ overwrite: true, intermediates: true });
    file.write(json);
    return ok(describe(file));
  } catch (error) {
    const appError = toAppError(error, 'I could not write that backup.');
    log.error('backup write failed', appError);
    return fail('unknown', 'I could not write that backup.', { cause: appError });
  }
}

/** Newest first. An unreadable folder is an empty list, never a crash. */
export function listBackups(): Result<BackupFileInfo[]> {
  try {
    const directory = folder();
    if (!directory.exists) return ok([]);
    const files = directory
      .list()
      .filter((entry): entry is File => entry instanceof File && entry.name.endsWith(SUFFIX))
      .map(describe)
      .sort((a, b) => b.savedAt - a.savedAt || b.name.localeCompare(a.name));
    return ok(files);
  } catch (error) {
    const appError = toAppError(error, 'I could not list your backups.');
    log.warn('backup list failed', appError);
    return fail('unknown', 'I could not list your backups.', { cause: appError });
  }
}

export function deleteBackup(uri: string): Result<void> {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
    return ok(undefined);
  } catch (error) {
    const appError = toAppError(error, 'I could not delete that backup.');
    log.warn('backup delete failed', appError);
    return fail('unknown', 'I could not delete that backup.', { cause: appError });
  }
}

export async function readBackup(uri: string): Promise<Result<string>> {
  try {
    return ok(await new File(uri).text());
  } catch (error) {
    const appError = toAppError(error, 'I could not open that file.');
    log.warn('backup read failed', appError);
    return fail('unknown', 'I could not open that file.', { cause: appError });
  }
}

/** Offers a saved backup to the share sheet. */
export async function shareBackup(uri: string, dialogTitle = 'Ridik backup'): Promise<Result<void>> {
  let available = false;
  try {
    available = await Sharing.isAvailableAsync();
  } catch (error) {
    log.warn('could not query the share sheet', error);
  }
  if (!available) {
    return fail('unsupported', 'Sharing is not available on this device.', { details: { uri } });
  }

  try {
    await Sharing.shareAsync(uri, {
      mimeType: 'application/json',
      UTI: 'public.json',
      dialogTitle,
    });
    return ok(undefined);
  } catch (error) {
    const appError = toAppError(error, 'I could not open the share sheet.');
    log.warn('backup share failed', appError);
    return fail('unknown', 'I could not open the share sheet.', { cause: appError });
  }
}

export type PickedBackup = { name: string; text: string };

/**
 * The system file picker, for a backup that lives anywhere but here — iCloud,
 * Drive, a cable, another phone. Cancelling is a normal answer and comes back
 * as `null` rather than as an error.
 *
 * The wildcard mime type sits alongside `application/json` on purpose: a file
 * arriving from Drive or a mail attachment is routinely typed
 * `application/octet-stream`, and a picker that greys out the user's own backup
 * is worse than one that lets them pick the wrong thing — `parseBackup` refuses
 * anything that is not ours, by name.
 */
export async function pickBackup(): Promise<Result<PickedBackup | null>> {
  try {
    const picked = await File.pickFileAsync({ mimeTypes: ['application/json', '*/*'] });
    if (picked.canceled) return ok(null);
    return ok({ name: picked.result.name, text: await picked.result.text() });
  } catch (error) {
    const appError = toAppError(error, 'I could not open that file.');
    log.warn('backup pick failed', appError);
    return fail('unsupported', 'I could not open the file picker on this device.', {
      cause: appError,
    });
  }
}
