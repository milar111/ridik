import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  FadeInUp,
  FadeOutUp,
  LinearTransition,
  ReduceMotion,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../ThemeProvider';
import { AnimatedPressable, usePressScale } from '../motionHooks';
import { Txt } from './Text';
import { FADE, FADE_OUT, REFLOW_MS } from '../motion';
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
            /*
             * The one place in the app that uses layout animations, and it can
             * because the stack renders in the provider tree rather than inside
             * a `Modal` — see `motionHooks` for why that distinction decides
             * the mechanism everywhere else.
             *
             * The three numbers are the vocabulary's, not this file's: `FADE`
             * arriving, the shorter `FADE_OUT` leaving (a dismissal that takes
             * as long as an arrival reads as reluctant), and `REFLOW_MS` for
             * the stack closing the gap — the same duration as the fade, so a
             * toast leaving and the ones above it dropping finish together
             * rather than in two beats.
             *
             * `reduceMotion` has to be said out loud here: a builder does not
             * inherit it from a config the way `withSpring` does, so without
             * this the one animated surface outside a sheet would be the only
             * thing still moving for someone who asked the OS to stop.
             */
            entering={FadeInUp.duration(FADE.duration).reduceMotion(ReduceMotion.System)}
            exiting={FadeOutUp.duration(FADE_OUT.duration).reduceMotion(ReduceMotion.System)}
            layout={LinearTransition.duration(REFLOW_MS).reduceMotion(ReduceMotion.System)}
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
            <Trailing
              action={t.action}
              onPress={() => {
                t.action?.onPress();
                onDismiss(t.id);
              }}
            />
          </Animated.View>
        );
      })}
    </View>
  );
}

/**
 * The toast's one control — its action, or the ✕ that stands in for it.
 *
 * Extracted because it needs its own animation state and a hook cannot be
 * called from inside a `map`. Both shapes had no press feedback at all, which
 * on the undo offer meant the one control in the app with a deadline gave no
 * sign it had been hit. Deep travel: a word or a 15pt glyph, nothing behind it.
 */
function Trailing({
  action,
  onPress,
}: {
  action: ToastInput['action'];
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const press = usePressScale({ scale: 0.86 });
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={action ? undefined : 'Dismiss'}
      onPress={onPress}
      hitSlop={8}
      {...press.handlers}
      style={press.style}
    >
      {action ? (
        <Txt variant="micro" style={{ color: colors.accent }}>
          {action.label.toUpperCase()}
        </Txt>
      ) : (
        <Ionicons name="close" size={15} color={colors.textTertiary} />
      )}
    </AnimatedPressable>
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
