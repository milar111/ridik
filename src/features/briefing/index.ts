/**
 * The briefing facade: collect, compose, and (optionally) say it out loud.
 *
 * Nothing here throws. A briefing is triggered from a widget, a notification or
 * a wake word, so a repository that is momentarily unhappy has to produce a
 * spoken apology rather than an unhandled rejection nobody is around to catch.
 */
import { createLogger } from '@/core/logger';
import { err, ok, toAppError, type Result } from '@/core/result';
import { getRepositories } from '@/repositories';
import { speak } from '@/voice';

import {
  collectBriefing,
  type BriefingData,
  type BriefingRepositories,
  type BriefingScope,
} from './collect';
import { composeSpoken, composeVisual, type BriefingBullets } from './compose';

const log = createLogger('briefing');

export type Briefing = {
  data: BriefingData;
  bullets: BriefingBullets;
  spoken: string;
};

export type BriefingOptions = {
  /** Injectable so a screen can brief off a test database. */
  repos?: BriefingRepositories;
  now?: number;
  zone?: string;
};

export async function generateBriefing(
  scope: BriefingScope = 'today',
  options: BriefingOptions = {},
): Promise<Result<Briefing>> {
  try {
    const data = await collectBriefing({
      repos: options.repos ?? getRepositories(),
      scope,
      now: options.now,
      zone: options.zone,
      logger: log,
    });
    return ok({ data, bullets: composeVisual(data), spoken: composeSpoken(data) });
  } catch (error) {
    const appError = toAppError(error, 'I could not put your briefing together.');
    log.error('briefing failed', appError);
    return err(appError);
  }
}

/**
 * Composes then speaks. The Result describes the *briefing*, not the speech:
 * a device with no TTS voice installed still produced a briefing worth showing.
 */
export async function speakBriefing(
  scope: BriefingScope = 'today',
  options: BriefingOptions = {},
): Promise<Result<Briefing>> {
  const briefing = await generateBriefing(scope, options);
  if (!briefing.ok) return briefing;
  try {
    await speak(briefing.value.spoken);
  } catch (error) {
    log.warn('could not speak the briefing', error);
  }
  return briefing;
}

/**
 * The spoken script alone, with an apology in place of a failure — the exact
 * shape `LlmEffects.generateBriefing` in '@/llm/executor' asks for.
 */
export async function briefingScript(scope: BriefingScope = 'today'): Promise<string> {
  const briefing = await generateBriefing(scope);
  return briefing.ok ? briefing.value.spoken : briefing.error.userMessage;
}

export { collectBriefing } from './collect';
export type {
  BriefingClass,
  BriefingCommitment,
  BriefingData,
  BriefingEvent,
  BriefingFocus,
  BriefingHabit,
  BriefingRepositories,
  BriefingScope,
  BriefingTask,
} from './collect';
export { briefingTimeline, composeSpoken, composeVisual, SPOKEN_WORD_CAP } from './compose';
export type { BriefingBullet, BriefingBullets, BriefingIcon } from './compose';
