/**
 * Not losing what was said.
 *
 * The audio is discarded the moment it has been transcribed, so the transcript
 * is the only record that a sentence was ever spoken — and every one of these
 * paths used to end with it being cleared. The review this is built from is the
 * most-upvoted low-star one in the whole competitor corpus: "I will dictate for
 * a long time and then it just won't transcribe and all of it will go to
 * waste."
 */
import { freezeClock } from '@/core/clock';

import { registerVoicePipeline, useVoiceStore, type VoicePipeline } from '../store';

const AT = Date.UTC(2026, 7, 11, 9, 0, 0);
let restoreClock: () => void;

/** Captures the handlers so a test can fire them late, as the recogniser does. */
function fakePipeline(overrides: Partial<VoicePipeline> = {}) {
  let handlers: Parameters<VoicePipeline['listen']>[0] | null = null;
  const impl: VoicePipeline = {
    listen: async (h) => {
      handlers = h;
    },
    stopListening: async () => {},
    process: async (transcript) => ({ transcript, items: [] }),
    speak: async () => {},
    stopSpeaking: async () => {},
    ...overrides,
  };
  return { impl, fire: () => handlers! };
}

beforeEach(() => {
  restoreClock = freezeClock(AT);
  useVoiceStore.getState().reset();
  // `reset()` deliberately keeps a recovered transcript; a test needs a phone
  // that has never lost anything.
  useVoiceStore.getState().discardRecovered();
});

afterEach(() => restoreClock());

describe('a turn that fails', () => {
  it('keeps the transcript instead of throwing it away with the error', async () => {
    registerVoicePipeline(
      fakePipeline({
        process: async () => {
          throw new Error('The assistant did not answer.');
        },
      }).impl,
    );

    await useVoiceStore.getState().submitText('remind me to send Ana the lab report on Friday');

    expect(useVoiceStore.getState().status).toBe('error');
    expect(useVoiceStore.getState().recovered).toEqual({
      text: 'remind me to send Ana the lab report on Friday',
      at: AT,
      reason: 'failed',
    });
  });

  /* The two holes this was written for. `close()` runs on a backdrop tap, a
     drag, Android Back and every result row; `reset()` runs at the start of
     the next turn. Both used to clear the only copy. */
  it('survives the sheet being closed', async () => {
    registerVoicePipeline(
      fakePipeline({
        process: async () => {
          throw new Error('offline');
        },
      }).impl,
    );

    await useVoiceStore.getState().submitText('book the lab for Tuesday at four');
    useVoiceStore.getState().close();

    expect(useVoiceStore.getState().recovered?.text).toBe('book the lab for Tuesday at four');
    // And the next turn is what actually empties `transcript`, which is why
    // `close()` alone was never enough to notice this was being lost.
    useVoiceStore.getState().reset();
    expect(useVoiceStore.getState().transcript).toBe('');
    expect(useVoiceStore.getState().recovered?.text).toBe('book the lab for Tuesday at four');
  });

  it('survives a reset', async () => {
    registerVoicePipeline(
      fakePipeline({
        process: async () => {
          throw new Error('offline');
        },
      }).impl,
    );

    await useVoiceStore.getState().submitText('log forty on groceries');
    useVoiceStore.getState().reset();

    expect(useVoiceStore.getState().recovered?.text).toBe('log forty on groceries');
  });

  /* Speaking again is the most natural thing to do after a failure, and it
     clears `transcript` on its way in. */
  it('survives the mic being tapped again', async () => {
    const { impl } = fakePipeline({
      process: async () => {
        throw new Error('offline');
      },
    });
    registerVoicePipeline(impl);

    await useVoiceStore.getState().submitText('note the resistors are 4k7');
    await useVoiceStore.getState().startListening();

    expect(useVoiceStore.getState().recovered?.text).toBe('note the resistors are 4k7');
  });
});

describe('a recogniser that dies mid-sentence', () => {
  /* Where a long dictation actually fails: the partials arrive, the final
     never does. Most of a paragraph is worth incomparably more than nothing. */
  it('keeps what it had heard so far', async () => {
    const { impl, fire } = fakePipeline();
    registerVoicePipeline(impl);

    await useVoiceStore.getState().startListening();
    fire().onPartial('ring the landlord about the boiler and');
    fire().onError('I did not catch that.', 'empty');

    expect(useVoiceStore.getState().recovered?.text).toBe(
      'ring the landlord about the boiler and',
    );
    // Something *was* heard, so this is not the silent-microphone case.
    expect(useVoiceStore.getState().heardNothing).toBe(false);
  });

  /* And when there is genuinely nothing — no final, no partial — the app says
     so plainly rather than offering "I didn't quite catch that" over a
     microphone that recorded a whole paragraph of silence. */
  it('says so loudly when it recorded nothing at all', async () => {
    const { impl, fire } = fakePipeline();
    registerVoicePipeline(impl);

    await useVoiceStore.getState().startListening();
    fire().onError('I did not catch that.', 'empty');

    expect(useVoiceStore.getState().heardNothing).toBe(true);
    expect(useVoiceStore.getState().recovered).toBeNull();
  });

  it('does not call a device with no recogniser a silent one', async () => {
    const { impl, fire } = fakePipeline();
    registerVoicePipeline(impl);

    await useVoiceStore.getState().startListening();
    fire().onError('This device has no speech recogniser.', 'unsupported');

    expect(useVoiceStore.getState().heardNothing).toBe(false);
    expect(useVoiceStore.getState().sttUnavailable).toBe(true);
  });

  it('clears the flag the moment the next session starts', async () => {
    const { impl, fire } = fakePipeline();
    registerVoicePipeline(impl);

    await useVoiceStore.getState().startListening();
    fire().onError('I did not catch that.', 'empty');
    await useVoiceStore.getState().startListening();

    expect(useVoiceStore.getState().heardNothing).toBe(false);
  });
});

describe('getting it back', () => {
  it('hands the text to the composer and opens the sheet', async () => {
    registerVoicePipeline(
      fakePipeline({
        process: async () => {
          throw new Error('offline');
        },
      }).impl,
    );

    await useVoiceStore.getState().submitText('add oat milk to the shopping list');
    useVoiceStore.getState().close();

    expect(useVoiceStore.getState().recoverTranscript()).toBe('add oat milk to the shopping list');
    expect(useVoiceStore.getState().draftSeed).toBe('add oat milk to the shopping list');
    expect(useVoiceStore.getState().expanded).toBe(true);
    // Out of the keeping place, because it is now in the composer where the
    // user can see it — and `keepDraft` is what puts it back if the sheet goes.
    expect(useVoiceStore.getState().recovered).toBeNull();
  });

  it('is consumed once, not on every render', () => {
    useVoiceStore.getState().keepDraft('half a sentence');
    useVoiceStore.getState().recoverTranscript();
    useVoiceStore.getState().consumeDraftSeed();

    expect(useVoiceStore.getState().draftSeed).toBeNull();
  });

  it('keeps a draft the sheet was dismissed over', () => {
    useVoiceStore.getState().keepDraft('  ring the dentist about Thursday  ');
    expect(useVoiceStore.getState().recovered).toEqual({
      text: 'ring the dentist about Thursday',
      at: AT,
      reason: 'unsent',
    });
  });

  it('does not keep an empty draft', () => {
    useVoiceStore.getState().keepDraft('   ');
    expect(useVoiceStore.getState().recovered).toBeNull();
  });

  it('empties only on an explicit discard', () => {
    useVoiceStore.getState().keepDraft('something long');
    useVoiceStore.getState().close();
    useVoiceStore.getState().reset();
    expect(useVoiceStore.getState().recovered).not.toBeNull();

    useVoiceStore.getState().discardRecovered();
    expect(useVoiceStore.getState().recovered).toBeNull();
  });
});

describe('when it stops being kept', () => {
  it('lets go once that same sentence has actually gone through', async () => {
    let fails = true;
    registerVoicePipeline(
      fakePipeline({
        process: async (transcript) => {
          if (fails) throw new Error('offline');
          return { transcript, items: [] };
        },
      }).impl,
    );

    await useVoiceStore.getState().submitText('log the gym');
    expect(useVoiceStore.getState().recovered?.text).toBe('log the gym');

    fails = false;
    await useVoiceStore.getState().submitText('log the gym');
    expect(useVoiceStore.getState().recovered).toBeNull();
  });

  /* A *different* utterance succeeding says nothing about the one still
     waiting. Clearing on any success is how the kept text would quietly
     vanish the next time the user said anything at all. */
  it('holds on when a different sentence succeeds', async () => {
    let fails = true;
    registerVoicePipeline(
      fakePipeline({
        process: async (transcript) => {
          if (fails) throw new Error('offline');
          return { transcript, items: [] };
        },
      }).impl,
    );

    await useVoiceStore.getState().submitText('remind me to renew the parking permit on the 30th');
    fails = false;
    await useVoiceStore.getState().submitText('what is next');

    expect(useVoiceStore.getState().recovered?.text).toBe(
      'remind me to renew the parking permit on the 30th',
    );
  });

  /* The other half of not nagging: a turn that landed is not kept at all, so
     the offer to restore never appears over work that was done. */
  it('keeps nothing at all after a turn that landed', async () => {
    registerVoicePipeline(fakePipeline().impl);

    await useVoiceStore.getState().submitText('add milk');
    useVoiceStore.getState().close();

    expect(useVoiceStore.getState().recovered).toBeNull();
  });
});
