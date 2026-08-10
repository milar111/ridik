/**
 * The briefing, as the modal sees it.
 *
 * Deliberately *not* re-exported from './index': the briefing facade reaches
 * the voice stack for speech, and only this one screen needs it. The barrel is
 * imported by every screen in the app, and this would ride along into all of
 * them.
 *
 * A briefing is a snapshot of a moment, so it is a query like any other read:
 * the modal opens on cached bullets and refreshes underneath them rather than
 * showing a spinner over a briefing it already has.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { unwrap } from '@/core/result';
import {
  generateBriefing,
  speakBriefing,
  type Briefing,
  type BriefingScope,
} from '@/features/briefing';
import { stopSpeaking } from '@/voice';

import { qk } from './keys';

export type { Briefing, BriefingScope };

export function useBriefing(scope: BriefingScope): UseQueryResult<Briefing> {
  return useQuery({
    queryKey: qk.briefing.scope(scope),
    // `generateBriefing` never throws; unwrapping turns "I could not put your
    // briefing together" into a query error the screen can offer a retry for.
    queryFn: async () => unwrap(await generateBriefing(scope)),
  });
}

export type BriefingSpeech = {
  isSpeaking: boolean;
  play: (scope: BriefingScope) => void;
  stop: () => void;
};

/**
 * Speaks the composed script and tracks whether it is still talking.
 *
 * Every start takes a generation number: a second Play, a Stop, or leaving the
 * screen makes the older utterance's completion callback a no-op, so the
 * button cannot flip back to "Play" because a run the user already abandoned
 * finished late.
 */
export function useBriefingSpeech(): BriefingSpeech {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const generation = useRef(0);

  useEffect(
    () => () => {
      // Dismissing the modal must not leave it talking to an empty room.
      generation.current++;
      void stopSpeaking();
    },
    [],
  );

  const play = useCallback((scope: BriefingScope) => {
    const mine = ++generation.current;
    setIsSpeaking(true);
    void speakBriefing(scope).finally(() => {
      if (generation.current === mine) setIsSpeaking(false);
    });
  }, []);

  const stop = useCallback(() => {
    generation.current++;
    setIsSpeaking(false);
    void stopSpeaking();
  }, []);

  return { isSpeaking, play, stop };
}
