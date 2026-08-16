import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp, LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../ThemeProvider';
import { Txt } from './Text';
import { newId } from '@/db/ids';

export type ToastTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

export type ToastInput = {
  message: string;
  detail?: string;
  tone?: ToastTone;
  durationMs?: number;
  action?: { label: string; onPress: () => void };
};

type Toast = ToastInput & { id: string };

type ToastApi = {
  show: (toast: ToastInput) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastApi>({ show: () => '', dismiss: () => {} });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const ICONS: Record<ToastTone, keyof typeof Ionicons.glyphMap> = {
  neutral: 'information-circle-outline',
  success: 'checkmark-circle-outline',
  warning: 'alert-circle-outline',
  danger: 'close-circle-outline',
  accent: 'sparkles-outline',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      const id = newId();
      // Cap the stack: a multi-intent utterance can produce many results at once
      // and burying the screen defeats the purpose.
      setToasts((prev) => [...prev.slice(-2), { ...input, id }]);
      const duration = input.durationMs ?? (input.action ? 6000 : 3200);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), duration),
      );
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  /*
   * The container stays mounted even with nothing in it, and that is not a
   * tidiness question — it is the difference between a toast appearing and not.
   *
   * This used to `return null` while the stack was empty, so the first toast
   * mounted its `Animated.View` into a host view created in the same commit.
   * Reanimated starts an `entering` animation from opacity 0 and needs the
   * parent to have been laid out to schedule it; with the parent brand new the
   * animation never ran and the toast sat invisible for its whole lifetime,
   * then "exited". Every toast in the app was affected — the voice receipt, the
   * undo offer, every error — and nothing looked broken, because a toast that
   * never appears is indistinguishable from one that was never raised.
   *
   * An empty `box-none` view has no pixels and takes no touches, so leaving it
   * mounted costs nothing.
   */
  const toneColor: Record<ToastTone, string> = {
    neutral: colors.textSecondary,
    success: colors.success,
    warning: colors.warning,
    danger: colors.danger,
    accent: colors.accent,
  };

  return (
    <View pointerEvents="box-none" style={[styles.stack, { top: insets.top + 6, gap: spacing.sm }]}>
      {toasts.map((t) => {
        const tone = t.tone ?? 'neutral';
        return (
          <Animated.View
            key={t.id}
            entering={FadeInUp.duration(180)}
            exiting={FadeOutUp.duration(140)}
            layout={LinearTransition.duration(160)}
            style={[
              styles.toast,
              {
                backgroundColor: colors.surfaceRaised,
                borderColor: colors.border,
                borderRadius: radius.md,
                borderLeftColor: toneColor[tone],
              },
            ]}
          >
            <Ionicons name={ICONS[tone]} size={18} color={toneColor[tone]} />
            <View style={{ flex: 1, gap: 1 }}>
              <Txt variant="caption" weight="600">
                {t.message}
              </Txt>
              {t.detail ? (
                <Txt variant="micro" tone="tertiary" numberOfLines={2}>
                  {t.detail}
                </Txt>
              ) : null}
            </View>
            {t.action ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  t.action?.onPress();
                  onDismiss(t.id);
                }}
                hitSlop={8}
              >
                <Txt variant="micro" style={{ color: colors.accent }}>
                  {t.action.label.toUpperCase()}
                </Txt>
              </Pressable>
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={() => onDismiss(t.id)} hitSlop={8}>
                <Ionicons name="close" size={15} color={colors.textTertiary} />
              </Pressable>
            )}
          </Animated.View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { position: 'absolute', left: 12, right: 12, zIndex: 100 },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
  },
});
