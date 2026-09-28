/**
 * The stop between hearing a sentence and paying for it — and when it fires.
 *
 * It used to fire on every utterance: the words went into the composer and the
 * user pressed Send. The reasoning was that this is the only check in the app
 * that reads *the words* rather than a reply, so a recogniser that heard
 * "doctor" for "tutor" costs a keystroke instead of a turn — everything else
 * (`confirmMode`, the executor's review gate, the handlers' own questions)
 * reads a reply, by which point the request has been made and billed.
 *
 * That is still true, and it never argued for asking about a sentence the
 * recogniser is confident about. The gate is now conditional on
 * `wasPoorlyHeard` — the app's own existing answer to "are these the words you
 * said", at a documented 0.85, already used by the confirmation gate. A
 * borderline transcript still stops here. A clean one goes.
 *
 * What holds the line instead is that the words are no longer unseen when they
 * are sent: the caption under the microphone is the live transcript, and what
 * commits is ending an utterance the user has been reading the whole time.
 *
 * It is still not a *setting* — `has no way to be switched off` below is the
 * test that keeps it that way.
 */
import { freezeClock } from '@/core/clock';

import { registerVoicePipeline, useVoiceStore, type VoicePipeline } from '../store';

const AT = Date.UTC(2026, 8, 2, 21, 37, 0);
const HEARD = 'book two hours for the robotics report on Thursday afternoon';
let restoreClock: () => void;

/** `onFinal` sends without awaiting, so a turn needs a microtask to land. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fakePipeline(overrides: Partial<VoicePipeline> = {}) {
  let handlers: Parameters<VoicePipeline['listen']>[0] | null = null;
  const process = jest.fn(async (transcript: string) => ({ transcript, items: [] }));
  const impl: VoicePipeline = {
    listen: async (h) => {
      handlers = h;
    },
    stopListening: async () => {},
    process,
    speak: async () => {},
    stopSpeaking: async () => {},
    ...overrides,
  };
  return { impl, process, fire: () => handlers! };
}

beforeEach(() => {
  restoreClock = freezeClock(AT);
  useVoiceStore.getState().reset();
  useVoiceStore.getState().discardRecovered();
});

afterEach(() => restoreClock());

describe('a sentence the recogniser heard well', () => {
  it('goes straight to the model with no box in the way', async () => {
    const fake = fakePipeline();
    registerVoicePipeline(fake.impl);

    await useVoiceStore.getState().startListening();
    fake.fire().onFinal(HEARD, 0.95);
    await flush();

    expect(fake.process).toHaveBeenCalledWith(HEARD, undefined);
    expect(useVoiceStore.getState().draftSeed).toBeNull();
  });

  /*
    The case that decides whether this feature is usable at all on Android.

    That fleet reports 0 or -1 for "unavailable" and iOS returns 0 on partials.
    `wasPoorlyHeard` reads a non-positive or non-finite value as *no evidence*
    rather than as bad news — and it has to, because the other reading puts the
    composer in front of every single write on every device that measures
    nothing, which is exactly the behaviour being removed.
  */
  it.each([
    ['nothing measured it', null],
    ['Android reported zero', 0],
    ['Android reported minus one', -1],
  ])('sends when %s', async (_why, confidence) => {
    const fake = fakePipeline();
    registerVoicePipeline(fake.impl);

    await useVoiceStore.getState().startListening();
    fake.fire().onFinal(HEARD, confidence as number | null);
    await flush();

    expect(fake.process).toHaveBeenCalledTimes(1);
    expect(useVoiceStore.getState().draftSeed).toBeNull();
  });

  /*
    The distinction the whole feature rests on. `recovered` means something went
    wrong and the words were rescued; a card on home says so. Nothing has gone
    wrong here, so a receipt about a lost sentence would be a lie about a
    working one.
  */
  it('is not a failure and does not file one', async () => {
    const fake = fakePipeline();
    registerVoicePipeline(fake.impl);

    await useVoiceStore.getState().startListening();
    fake.fire().onFinal(HEARD, 0.95);
    await flush();

    expect(useVoiceStore.getState().error).toBeNull();
    expect(useVoiceStore.getState().recovered).toBeNull();
  });
});

describe('a sentence the recogniser may have got wrong', () => {
  it('stops in the composer instead of calling the model', async () => {
    const fake = fakePipeline();
    registerVoicePipeline(fake.impl);

    await useVoiceStore.getState().startListening();
    // Under REVIEW_CONFIDENCE_THRESHOLD (0.85) — see `wasPoorlyHeard`.
    fake.fire().onFinal(HEARD, 0.5);
    await flush();

    expect(fake.process).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().draftSeed).toEqual({ text: HEARD, reason: 'review' });
    expect(useVoiceStore.getState().expanded).toBe(true);
    expect(useVoiceStore.getState().status).toBe('idle');
  });

  /** The point of the box: the corrected words are what gets sent. */
  it('sends the edit rather than what was heard', async () => {
    const fake = fakePipeline();
    registerVoicePipeline(fake.impl);

    await useVoiceStore.getState().startListening();
    fake.fire().onFinal('remind me to email the doctor', 0.4);
    await flush();
    await useVoiceStore.getState().submitText('remind me to email the tutor');

    expect(fake.process).toHaveBeenCalledWith('remind me to email the tutor', undefined);
    expect(fake.process).toHaveBeenCalledTimes(1);
  });
});

describe('what the gate must not become', () => {
  /*
    Guarding the decision itself rather than an implementation of it. This
    shipped for one afternoon as a Settings switch and the switch was removed
    the same day: a preference that can turn off the only free correction point
    in the app is a preference that will be turned off by somebody who then
    dictates a sentence into a calendar they cannot easily undo.

    Conditional on confidence is not the same thing as configurable: there is
    still nothing a user or a pipeline can set to change it.
  */
  it('has no way to be switched off', async () => {
    const fake = fakePipeline();
    registerVoicePipeline(fake.impl);
    expect(Object.keys(fake.impl)).not.toContain('reviewBeforeSending');

    await useVoiceStore.getState().startListening();
    fake.fire().onFinal(HEARD, 0.5);
    await flush();

    expect(fake.process).not.toHaveBeenCalled();
  });

  /*
    The recogniser talks after it is stopped. Running a turn for a session the
    user has already walked away from is worse than opening a box over it, and
    auto-sending is what makes that possible — so the ticket matters more now,
    not less.
  */
  it('ignores a transcript from a session that has been superseded', async () => {
    const fake = fakePipeline();
    registerVoicePipeline(fake.impl);

    await useVoiceStore.getState().startListening();
    const late = fake.fire();
    useVoiceStore.getState().reset();
    late.onFinal(HEARD, 0.95);
    await flush();

    expect(useVoiceStore.getState().draftSeed).toBeNull();
    expect(fake.process).not.toHaveBeenCalled();
  });

  /*
    An answer to a clarification has to keep carrying the pending token, or the
    model is handed a bare sentence with no idea which question it answers — and
    the second half of a two-part turn silently becomes a first half.

    `submitText` reads `pendingClarification` itself, which is exactly why
    `onFinal` sends through it rather than calling `process` directly.
  */
  it('still answers the question when the answer is spoken', async () => {
    const fake = fakePipeline({
      process: jest.fn(async (transcript: string) => ({
        transcript,
        items: [],
        clarification: { question: 'Which Ivo?', pending: 'PENDING-1' },
      })),
    });
    registerVoicePipeline(fake.impl);

    await useVoiceStore.getState().submitText('cancel my meeting with Ivo');
    expect(useVoiceStore.getState().pendingClarification?.pending).toBe('PENDING-1');

    await useVoiceStore.getState().startListening();
    fake.fire().onFinal('the one from the robotics club', 0.95);
    await flush();

    expect(fake.impl.process).toHaveBeenLastCalledWith('the one from the robotics club', {
      pending: 'PENDING-1',
    });
  });
});

/*
  The gap the user actually sees, and the reason `sending` exists.

  The recogniser is allowed up to 2.5s to return a final result after being
  asked to stop. For all of it the store used to say `idle`, so lifting a finger
  put the resting caption back over a sentence still being read, cooled the
  field, and then a receipt arrived from nowhere. Nothing was wrong except what
  the screen said.
*/
describe('the window between finishing and the turn starting', () => {
  it('does not fall back to idle while the recogniser is still finalising', async () => {
    const fake = fakePipeline();
    registerVoicePipeline(fake.impl);

    await useVoiceStore.getState().startListening();
    expect(useVoiceStore.getState().status).toBe('listening');

    await useVoiceStore.getState().stopListening();

    expect(useVoiceStore.getState().status).toBe('sending');
  });

  it('hands over to the turn without passing through idle', async () => {
    const fake = fakePipeline();
    registerVoicePipeline(fake.impl);

    await useVoiceStore.getState().startListening();
    await useVoiceStore.getState().stopListening();
    fake.fire().onFinal(HEARD, 0.95);

    // Synchronously after the words land: already the turn, never the resting
    // state in between.
    expect(useVoiceStore.getState().status).toBe('thinking');
    await flush();
  });
});
