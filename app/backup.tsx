/**
 * Backup and restore — the screen that makes "your data is yours" true.
 *
 * The markdown export next door is for reading. This is the one that can come
 * back: a JSON file of every row, and a restore that puts the missing ones in.
 *
 * The whole screen is organised around one sentence, and it is the sentence a
 * user is most likely to be wrong about: **restoring merges. It never
 * replaces.** "Restore" means *replace* in most software anybody has ever met,
 * and being wrong about which one this is costs a database — so it is on the
 * screen, and it is in the question asked before anything runs, with the
 * counted consequence of this particular file attached to it.
 */
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import Constants from 'expo-constants';

import { formatDateTime } from '@/core/time';
import { countLabel } from '@/core/format';
import { formatBytes, Group, Row } from '@/features/settings';
import { describeImport, type Backup } from '@/features/export';
import {
  useBackups,
  useDeleteBackup,
  useLoadBackup,
  useRestoreBackup,
  useSaveBackup,
  useShareBackup,
  type LoadedBackup,
} from '@/hooks/useBackup';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import { Button, Card, Screen, Section, Txt, useConfirm, useToast } from '@/ui/components';

export default function BackupScreen() {
  return (
    <Screen back title="Backup">
      <ErrorBoundary label="backup: save">
        <SaveGroup />
      </ErrorBoundary>
      <ErrorBoundary label="backup: restore">
        <RestoreGroup />
      </ErrorBoundary>
    </Screen>
  );
}

/* -------------------------------------------------------------------- save */

function SaveGroup() {
  const save = useSaveBackup();
  const toast = useToast();
  const { spacing } = useTheme();

  return (
    <Section title="Save a backup">
      <Card>
        <View style={{ gap: spacing.sm }}>
          <Txt variant="body" tone="secondary">
            One file with every note, task, list, event, habit, transaction and person on this
            phone. Ridik has no account, and the server it talks to never receives any of it, so
            this file is the only backup that exists — keep it somewhere that is not this phone.
          </Txt>
          <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
            <Button
              label="Save and share"
              icon="save-outline"
              variant="primary"
              loading={save.isPending}
              onPress={() =>
                save.mutate(undefined, {
                  onSuccess: (file) =>
                    toast.show({ message: `Saved ${file.name}`, tone: 'success' }),
                  onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
                })
              }
            />
          </View>
          <Txt variant="micro" tone="tertiary">
            The copy kept on this phone survives “Delete all data”, but not deleting the app.
            Version {Constants.expoConfig?.version ?? '1.0.0'}.
          </Txt>
        </View>
      </Card>
    </Section>
  );
}

/* ----------------------------------------------------------------- restore */

function RestoreGroup() {
  const backups = useBackups();
  const load = useLoadBackup();
  const restore = useRestoreBackup();
  const share = useShareBackup();
  const remove = useDeleteBackup();
  const confirm = useConfirm();
  const toast = useToast();
  const { spacing } = useTheme();
  const [loaded, setLoaded] = useState<LoadedBackup | null>(null);

  /**
   * The counted summary afterwards, in the app's own terms: what went in, what
   * was already here, what could not be placed. A restore that reported only
   * "done" would hide the skips, which are the whole reason merging is safe.
   */
  const runRestore = useCallback(
    (backup: Backup) => {
      restore.mutate(backup, {
        onSuccess: (summary) => {
          setLoaded(null);
          const parts = [`${countLabel(summary.inserted, 'row')} restored`];
          if (summary.existing > 0) parts.push(`${summary.existing} already here`);
          if (summary.conflicted + summary.orphaned > 0) {
            parts.push(`${summary.conflicted + summary.orphaned} skipped`);
          }
          toast.show({ message: parts.join(' · '), tone: 'success' });
        },
        onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
      });
    },
    [restore, toast],
  );

  /**
   * The question, and the only place a restore can be started from.
   *
   * It says what this file will do to *this* phone, in rows, before the button
   * that does it. `destructive: false` is not cosmetic either — a merge
   * destroys nothing, and dressing it in the danger colour the erase button
   * wears would teach the user that the two are the same kind of act.
   */
  const askThenRestore = useCallback(
    (file: LoadedBackup) => {
      if (file.plan.refusal) {
        toast.show({ message: file.plan.refusal, tone: 'danger' });
        return;
      }
      confirm.ask({
        title: 'Restore this backup?',
        message: `${describeImport(file.plan)} Taken ${formatDateTime(file.backup.exportedAt)}.`,
        confirmLabel: 'Restore',
        destructive: false,
        onConfirm: () => runRestore(file.backup),
      });
    },
    [confirm, runRestore, toast],
  );

  const openFile = (source: { uri: string; name: string } | 'pick') => {
    load.mutate(source, {
      onSuccess: (file) => {
        // Cancelling the picker is an answer, and answering it with an error
        // toast would be the app telling the user off for changing their mind.
        if (!file) return;
        setLoaded(file);
        askThenRestore(file);
      },
      onError: (error) => toast.show({ message: error.message, tone: 'danger' }),
    });
  };

  const files = backups.data ?? [];

  return (
    <>
      <Section title="Restore">
        <Card>
          <View style={{ gap: spacing.sm }}>
            {/* The load-bearing sentence on this screen. */}
            <Txt variant="body">
              Restoring <Txt variant="bodyStrong">adds</Txt> what is missing. Nothing on this
              phone is deleted, and anything already here is kept exactly as it is — including
              rows you have edited since the backup was taken.
            </Txt>
            <Txt variant="caption" tone="secondary">
              Rows that clash with something different — a habit of the same name, say — are
              skipped and counted rather than overwriting what you have.
            </Txt>
            <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
              <Button
                label="Choose a file"
                icon="folder-open-outline"
                variant="primary"
                loading={load.isPending || restore.isPending}
                onPress={() => openFile('pick')}
              />
              {loaded ? (
                <Button
                  label="Review again"
                  icon="reader-outline"
                  onPress={() => askThenRestore(loaded)}
                />
              ) : null}
            </View>
          </View>
        </Card>
      </Section>

      <Group title="On this phone">
        {files.length === 0 ? (
          <Row
            icon="archive-outline"
            label="No backups saved yet"
            hint={
              backups.isLoading ? 'Looking…' : 'Save one above and it will be listed here.'
            }
          />
        ) : (
          files.map((file) => (
            <Row
              key={file.uri}
              icon="document-outline"
              label={file.name}
              value={`${file.savedAt > 0 ? formatDateTime(file.savedAt) : 'Saved'} · ${formatBytes(file.bytes)}`}
              right={
                <View style={{ flexDirection: 'row', gap: spacing.xs }}>
                  <Button
                    label="Restore"
                    size="sm"
                    onPress={() => openFile({ uri: file.uri, name: file.name })}
                  />
                  <Button
                    icon="share-outline"
                    size="sm"
                    variant="ghost"
                    accessibilityLabel={`Share ${file.name}`}
                    onPress={() =>
                      share.mutate(file.uri, {
                        onError: (error) =>
                          toast.show({ message: error.message, tone: 'danger' }),
                      })
                    }
                  />
                  <Button
                    icon="trash-outline"
                    size="sm"
                    variant="ghost"
                    accessibilityLabel={`Delete ${file.name}`}
                    onPress={() =>
                      confirm.ask({
                        title: 'Delete this backup?',
                        message: `${file.name} is a copy of your data, not your data. Deleting it changes nothing in the app.`,
                        confirmLabel: 'Delete',
                        onConfirm: () =>
                          remove.mutate(file.uri, {
                            onError: (error) =>
                              toast.show({ message: error.message, tone: 'danger' }),
                          }),
                      })
                    }
                  />
                </View>
              }
            />
          ))
        )}
      </Group>

      {confirm.dialog}
    </>
  );
}
