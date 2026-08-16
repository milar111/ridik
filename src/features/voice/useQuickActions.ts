import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as QuickActions from 'expo-quick-actions';
import { useRouter } from 'expo-router';

import { createLogger } from '@/core/logger';
import { speakHref } from './speakIntent';

const log = createLogger('quick-actions');

/**
 * Long-press the home-screen icon to start talking.
 *
 * The brief asks for the mic to be reachable "via app launch, home screen
 * widget, or system shortcut"; this is the shortcut. iOS gets its actions from
 * the config plugin at build time, Android needs them registered at runtime, so
 * both are declared here and the iOS registration is simply idempotent.
 */
const ACTIONS: QuickActions.Action[] = [
  {
    id: 'speak',
    title: 'Speak to Ridik',
    subtitle: 'Capture a thought hands-free',
    icon: Platform.OS === 'ios' ? 'symbol:mic.fill' : 'mic',
    params: { action: 'speak' },
  },
  {
    id: 'briefing',
    title: "Today's briefing",
    icon: Platform.OS === 'ios' ? 'symbol:sparkles' : undefined,
    params: { action: 'briefing' },
  },
];

/**
 * Whether the action this process launched with has already been dealt with.
 *
 * Module state rather than a ref, because it is a property of the *launch* and
 * not of any component: `QuickActions.initial` is read once at module load
 * (`export const initial = ExpoQuickActions?.initial`) and is never cleared, so
 * it stays truthy for the whole life of the process. A remount — a Fast
 * Refresh, a re-created navigator — would otherwise replay a long-press the
 * user made minutes ago.
 */
let consumedInitial = false;

/** Exported for the test that proves the launch action fires exactly once. */
export function resetQuickActionsForTest(): void {
  consumedInitial = false;
}

export function useQuickActionRouting(): void {
  const router = useRouter();

  useEffect(() => {
    void QuickActions.setItems(ACTIONS).catch((error: unknown) =>
      log.warn('could not publish quick actions', error),
    );
  }, []);

  /**
   * The handler, behind a ref, because the subscription below must never be
   * torn down and rebuilt.
   *
   * `useQuickActionCallback` from `expo-quick-actions/hooks` is what this
   * replaces, and it cannot be used here: its effect depends on
   * `[QuickActions.initial, callback]`, `initial` is a module constant that
   * never changes *or clears*, and an inline callback is a new identity on
   * every render — so the effect re-runs on every render of its host and
   * re-delivers the same launch action each time. The host is `VoiceDock`,
   * mounted app-wide and re-rendering on every path change and every partial
   * transcript. One long-press on "Speak to Ridik" therefore became a
   * navigation to `/?speak=1` on every re-render: the menu could not be opened
   * (it was popped straight back to home), and each partial transcript
   * re-armed home, which restarts listening and throws the in-flight utterance
   * away — a sentence that can never finish.
   */
  const handle = useRef<(action: QuickActions.Action) => void>(() => {});
  useEffect(() => {
    handle.current = (action) => {
      const id = action.params?.['action'] ?? action.id;
      if (id === 'briefing') {
        router.push('/briefing');
        return;
      }
      if (id === 'speak') {
        // Through the route, not straight at the store.
        //
        // Calling `startListening()` from here worked and was still wrong: a
        // long-press on the icon is almost always a *cold* launch, and this
        // callback can run before bootstrap has registered the pipeline —
        // which the store correctly reports as "Voice is still starting up.",
        // i.e. an error message in place of the entire product. The route
        // waits for the recogniser instead of racing it, and it is the same
        // address the widgets and the Control Center button use, so there is
        // one path to test.
        //
        // `navigate` rather than `push`: home is already on the stack on every
        // launch, and pushing would put a second copy of it over the first.
        router.navigate(speakHref());
      }
    };
  }, [router]);

  useEffect(() => {
    if (!consumedInitial && QuickActions.initial) {
      consumedInitial = true;
      handle.current(QuickActions.initial);
    }
    const subscription = QuickActions.addListener((action) => handle.current(action));
    return () => subscription.remove();
  }, []);
}
