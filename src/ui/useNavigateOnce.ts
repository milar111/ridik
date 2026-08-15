import { useCallback, useRef } from 'react';
import { useFocusEffect, useRouter, type Href } from 'expo-router';

/**
 * `router.push`, but a fast double tap cannot push the same screen twice.
 *
 * expo-router does not de-duplicate: two taps 80ms apart put two copies of
 * Settings on the stack, and the user has to press Back twice to get out of
 * what looked like one screen. The window is short enough that a deliberate
 * second navigation still works, and it is released as soon as the screen the
 * tap came from is focused again — so coming Back and immediately tapping
 * something else is never blocked by a timer that has not run out.
 */
const WINDOW_MS = 700;

export type NavigateOnce = {
  push: (href: Href) => void;
  replace: (href: Href) => void;
};

export function useNavigateOnce(): NavigateOnce {
  const router = useRouter();
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Returning to this screen means the navigation it made has been undone, so
  // whatever is on it may be tapped again immediately.
  useFocusEffect(
    useCallback(() => {
      busy.current = false;
      return () => {
        if (timer.current) clearTimeout(timer.current);
      };
    }, []),
  );

  const guard = useCallback((go: () => void) => {
    if (busy.current) return;
    busy.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      busy.current = false;
    }, WINDOW_MS);
    go();
  }, []);

  return {
    push: useCallback((href: Href) => guard(() => router.push(href)), [guard, router]),
    // Guarded too, even though a replace cannot stack: the second tap lands on
    // a screen that is already unmounting and replaces whatever arrived first.
    replace: useCallback((href: Href) => guard(() => router.replace(href)), [guard, router]),
  };
}
