/**
 * The stop between hearing a sentence and paying for it.
 *
 * It is the only check in this app that fires *before* the model is called.
 * Everything else — `confirmMode`, the executor's review gate, the handlers'
 * own questions — reads a reply, which means the request has already been made
 * and billed by the time any of them can ask. This one reads the words, so a
 * recogniser that heard "doctor" for "tutor" costs a keystroke instead of a
 * turn.
 *
 * It is not configurable, and `has no way to be switched off` below is the test
 * that keeps it that way. Sending is one tap; unsending is not a thing that
 * exists. `LastAction` undoes a single row through an allow-list, so one
 * mis-heard sentence that filed three actions is three separate corrections —
 * some of which (a note upsert, a habit log) cannot be made at all.
 */
import { freezeClock } from '@/core/clock';

import { registerVoicePipeline, useVoiceStore, type VoicePipeline } from '../store';

const AT = Date.UTC(2026, 8, 2, 21, 37, 0);
const HEARD = 'book two hours for the robotics report on Thursday afternoon';
let restoreClock: () => void;

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

describe('checking before sending', () => {
  it('puts the words in the composer instead of calling the model', async () => {
    const fake = fakePipeline();
    registerVoicePipeline(fake.impl);

    await useVoiceStore.getState().startListening();
    fake.fire().onFinal(HEARD, null);

    expect(fake.process).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().draftSeed).toEqual({ text: HEARD, reason: 'review' });
    expect(useVoiceStore.getState().expanded).toBe(true);
  });

  /*
    The distinction the whole feature rests on. `recovered` means something went
    wrong and the words were rescued; a card on home says so. Nothing has gone
    wrong here, so a receipt about a lost sentence would be a lie about a
    working one — and the status must not read as an error either, or the mic
    sits red over a transcript that is perfectly fine.
  */
  it('is not a failure and does not file one', async () => {
    const fake = fakePipeline();
    registerVoicePipeline(fake.impl);

    await useVoiceStore.getState().startListening();
    fake.fire().onFinal(HEARD, null);

    expect(useVoiceStore.getState().status).toBe('idle');
    expect(useVoiceStore.getState().error).toBeNull();
    expect(useVoiceStore.getState().recovered).toBeNull();
  });

  /*
    Guarding the decision itself rather than an implementation of it. This
    shipped for one afternoon as a Settings switch and the switch was removed
    the same day: a preference that can turn off the only free correction point
    in the app is a preference that will be turned off by somebody who then
    dictates a sentence into a calendar they cannot easily undo. If a config
    seam ever grows back here, this fails.
  */
  it('has no way to be switched off', async () => {
    const fake = fakePipeline();
    registerVoicePipeline(fake.impl);
    // A pipeline is the only thing the store will take configuration from, and
    // it has nothing to say on the subject.
    expect(Object.keys(fake.impl)).not.toContain('reviewBeforeSending');

    await useVoiceStore.getState().startListening();
    fake.fire().onFinal(HEARD, null);

    expect(fake.process).not.toHaveBeenCalled();
  });

  /*
    The recogniser talks after it is stopped. Opening a box over a session the
    user has already walked away from is the quieter version of running a turn
    for it, and needs the same ticket.
  */
  it('ignores a transcript from a session that has been superseded', async () => {
    const fake = fakePipeline();
    registerVoicePipeline(fake.impl);

    await useVoiceStore.getState().startListening();
    const late = fake.fire();
    useVoiceStore.getState().reset();
    late.onFinal(HEARD, null);

    expect(useVoiceStore.getState().draftSeed).toBeNull();
    expect(fake.process).not.toHaveBeenCalled();
  });

  /*
    An answer to a clarification goes through the same box, which is new: before
    the gate was unconditional, speaking an answer submitted it directly. It has
    to keep carrying the pending token, or the model is handed a bare sentence
    with no idea which question it answers — and the second half of a two-part
    turn silently becomes a first half.
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
    fake.fire().onFinal('the one from the robotics club', null);
    expect(useVoiceStore.getState().draftSeed).toEqual({
      text: 'the one from the robotics club',
      reason: 'review',
    });

    await useVoiceStore.getState().submitText('the one from the robotics club');
    expect(fake.impl.process).toHaveBeenLastCalledWith('the one from the robotics club', {
      pending: 'PENDING-1',
    });
  });

  /** The point of the box: the corrected words are what gets sent. */
  it('sends the edit rather than what was heard', async () => {
    const fake = fakePipeline();
    registerVoicePipeline(fake.impl);

    await useVoiceStore.getState().startListening();
    fake.fire().onFinal('remind me to email the doctor', null);
    await useVoiceStore.getState().submitText('remind me to email the tutor');

    expect(fake.process).toHaveBeenCalledWith('remind me to email the tutor', undefined);
    expect(fake.process).toHaveBeenCalledTimes(1);
  });
});
