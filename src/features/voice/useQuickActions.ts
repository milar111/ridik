import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as QuickActions from 'expo-quick-actions';
import { useQuickActionCallback } from 'expo-quick-actions/hooks';
import { useRouter } from 'expo-router';

import { createLogger } from '@/core/logger';
import { useVoiceStore } from './store';

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

export function useQuickActionRouting(): void {
  const router = useRouter();
  const startListening = useVoiceStore((s) => s.startListening);

  useEffect(() => {
    void QuickActions.setItems(ACTIONS).catch((error: unknown) =>
      log.warn('could not publish quick actions', error),
    );
  }, []);

  useQuickActionCallback((action) => {
    const id = action.params?.['action'] ?? action.id;
    if (id === 'briefing') {
      router.push('/briefing');
      return;
    }
    if (id === 'speak') {
      // The pipeline registers during bootstrap; a cold launch can land here
      // first, and the store already reports that as a friendly error.
      void startListening();
    }
  });
}
