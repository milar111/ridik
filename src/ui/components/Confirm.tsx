/**
 * "Are you sure?", asked in the app's own voice.
 *
 * `Alert.alert` is a `UIAlertController` on iOS and a Material `AlertDialog` on
 * Android. Neither can be told anything about the palette, the faces or the
 * radii: the app spends a whole screen being warm and then destroys a note
 * through a grey system box in Roboto with a tinted-blue "Delete". The two
 * dialogs also disagree about the order of their buttons and about what
 * `style: 'destructive'` means — Android has no such thing, so the dangerous
 * choice arrives looking exactly like the safe one.
 *
 * The vocabulary here is the one `RowConfirm` in `app/person/[id].tsx` and the
 * inline confirm in `app/curriculum.tsx` already settled on: the question, a
 * danger button for the thing that cannot be undone, and a ghost button for
 * backing out. This is those two, in a sheet that can be raised from anywhere.
 *
 * It is a hook rather than a provider because that is how the rest of the app
 * raises a second surface: `NoteActionsSheet` renders `ChangeTagSheet` as a
 * sibling `Modal`, never a nested one. Callers spread `dialog` into their tree
 * and call `ask`.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '../ThemeProvider';
import { Button } from './Button';
import { Txt } from './Text';
import { elevate } from '../shadow';

export type ConfirmRequest = {
  /** The question. Ends in a question mark; it is a question. */
  title: string;
  /** What goes with a yes — counts, names, whatever makes the answer informed. */
  message?: string;
  /** Defaults to "Delete". */
  confirmLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /**
   * Whether saying yes destroys something. Defaults to true, because a question
   * worth interrupting someone with usually does.
   */
  destructive?: boolean;
  onConfirm: () => void;
};

export type Confirm = {
  ask: (request: ConfirmRequest) => void;
  dialog: ReactNode;
};

export function useConfirm(): Confirm {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const ask = useCallback((next: ConfirmRequest) => setRequest(next), []);
  const dismiss = useCallback(() => setRequest(null), []);

  return useMemo(
    () => ({ ask, dialog: <ConfirmDialog request={request} onDismiss={dismiss} /> }),
    [ask, dismiss, request],
  );
}

function ConfirmDialog({
  request,
  onDismiss,
}: {
  request: ConfirmRequest | null;
  onDismiss: () => void;
}) {
  const { colors, radius, spacing } = useTheme();

  return (
    <Modal
      visible={request !== null}
      transparent
      animationType="fade"
      // Android's hardware Back. Without it the dialog is a trap there and a
      // swipe-away on iOS, which is the divergence in miniature.
      onRequestClose={onDismiss}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        style={[styles.backdrop, { backgroundColor: colors.overlay }]}
        onPress={onDismiss}
      />
      <View style={[styles.centre, { padding: spacing.xl }]} pointerEvents="box-none">
        <View
          // The pair that makes a screen reader treat this as the only thing on
          // screen: the first is read by iOS, the second by Android. Two props
          // for one behaviour is the platforms disagreeing about spelling, not
          // the app behaving differently.
          accessibilityViewIsModal
          accessibilityLiveRegion="assertive"
          style={[
            styles.card,
            elevate('floating'),
            {
              backgroundColor: colors.surfaceRaised,
              borderColor: colors.border,
              borderRadius: radius.lg,
              padding: spacing.lg,
              gap: spacing.sm,
            },
          ]}
        >
          <Txt variant="heading">{request?.title ?? ''}</Txt>
          {request?.message ? (
            <Txt variant="caption" tone="secondary">
              {request.message}
            </Txt>
          ) : null}
          <View style={[styles.actions, { gap: spacing.sm, marginTop: spacing.xs }]}>
            <Button
              label={request?.cancelLabel ?? 'Cancel'}
              variant="ghost"
              onPress={onDismiss}
            />
            <Button
              label={request?.confirmLabel ?? 'Delete'}
              variant={request?.destructive === false ? 'primary' : 'danger'}
              onPress={() => {
                const confirmed = request?.onConfirm;
                onDismiss();
                confirmed?.();
              }}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: { width: '100%', maxWidth: 380, borderWidth: StyleSheet.hairlineWidth },
  // Both on the right and the dangerous one last, on both platforms. iOS and
  // Android disagree about this and only one of them can be right here.
  actions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap' },
});
