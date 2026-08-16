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

  /**
   * The hole every one of the tests above missed, because every one of them
   * makes `process` *throw*.
   *
   * The real pipeline never does. `client.interpret` returns an error Result
   * for a transport failure, the orchestrator turns it into a resolved
   * `TurnOutcome` carrying an apology and no items, and the store's success
   * branch ran: status idle, error null, nothing kept. `unanswered()` then
   * judged the sentence answered — `outcome.transcript === text` and no error
   * — so the words were gone from the store on the next mic tap, and on home
   * nothing was drawn at all: `LastAction` returns null for an outcome with no
   * applied items, and the sheet has no reason to open. A twenty-word
   * dictation that timed out on a train survived only in the audit table.
   */
  it('keeps the words when the model was never reached at all', async () => {
    registerVoicePipeline(
      fakePipeline({
        process: async (transcript) => ({
          transcript,
          feedback: 'I could not reach the assistant just now.',
          items: [],
          failed: true,
        }),
      }).impl,
    );

    await useVoiceStore
      .getState()
      .submitText('note that the lab needs 10k resistors and a new soldering tip');

    expect(useVoiceStore.getState().recovered).toEqual({
      text: 'note that the lab needs 10k resistors and a new soldering tip',
      at: AT,
      reason: 'failed',
    });
  });

  /* And it must still be there after the two things that clear `transcript` —
     the same pair the thrown-error case is held to. */
  it('holds an unreached turn across a close and the next session', async () => {
    registerVoicePipeline(
      fakePipeline({
        process: async (transcript) => ({ transcript, feedback: 'offline', items: [], failed: true }),
      }).impl,
    );

    await useVoiceStore.getState().submitText('move the dentist to Thursday morning');
    useVoiceStore.getState().close();
    await useVoiceStore.getState().startListening();

    expect(useVoiceStore.getState().recovered?.text).toBe('move the dentist to Thursday morning');
  });

  /* A turn that ran and simply had nothing to do is not a failure, and an
     offer to "put it back" over work that was understood is noise. */
  it('does not keep a turn that ran and wrote nothing', async () => {
    registerVoicePipeline(
      fakePipeline({
        process: async (transcript) => ({ transcript, feedback: 'Nothing to do.', items: [] }),
      }).impl,
    );

    await useVoiceStore.getState().submitText('thanks');

    expect(useVoiceStore.getState().recovered).toBeNull();
  });
});

/**
 * Sending while the last turn is still in flight.
 *
 * `submitText` refuses a second turn — ten taps in a second used to run ten
 * billable turns in parallel — but refusing silently is its own data loss: the
 * dock clears its box on Send, and the box stays mounted through a turn
 * whenever a clarification is pending. "Answer the question, model is slow,
 * retype it, press Send" emptied the field and dropped the sentence with no
 * error, no receipt and nothing kept.
 */
describe('a send that is refused', () => {
  it('keeps the sentence rather than dropping it', async () => {
    let release: (() => void) | null = null;
    registerVoicePipeline(
      fakePipeline({
        process: async (transcript) => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { transcript, items: [] };
        },
      }).impl,
    );

    const inFlight = useVoiceStore.getState().submitText('is that the Tuesday one');
    expect(useVoiceStore.getState().status).toBe('thinking');

    await useVoiceStore.getState().submitText('no, ring the landlord about the boiler on Thursday');

    expect(useVoiceStore.getState().recovered).toEqual({
      text: 'no, ring the landlord about the boiler on Thursday',
      at: AT,
      reason: 'unsent',
    });

    release!();
    await inFlight;
  });

  /* The other silent drop on the same path: a typed sentence submitted before
     the pipeline has finished registering. */
  it('keeps the sentence when the pipeline is not up yet', async () => {
    registerVoicePipeline(undefined as unknown as VoicePipeline);

    await useVoiceStore.getState().submitText('log forty on groceries');

    expect(useVoiceStore.getState().recovered?.text).toBe('log forty on groceries');

    // The pipeline is module state, not store state; leaving it null would
    // fail every test after this one for the wrong reason.
    registerVoicePipeline(fakePipeline().impl);
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

  /**
   * The edit, which is the whole reason "Put it back" exists.
   *
   * The dock used to call `keepDraft(draft)` and then `close()`, and `close()`
   * recomputes the slot from `state.transcript` — which is still the *original*
   * sentence, because a failed turn leaves it there. So the older words won and
   * the correction was destroyed by the one feature whose entire purpose is not
   * losing typed words, on a backdrop tap: the easiest accidental gesture on
   * the screen, and the documented safe exit.
   */
  it('prefers the edited draft over the sentence it came from', async () => {
    registerVoicePipeline(
      fakePipeline({
        process: async () => {
          throw new Error('offline');
        },
      }).impl,
    );

    await useVoiceStore.getState().submitText('add milk to the shopping list');
    useVoiceStore.getState().recoverTranscript();
    useVoiceStore.getState().close('add milk and eggs to the shopping list on Friday');

    expect(useVoiceStore.getState().recovered?.text).toBe(
      'add milk and eggs to the shopping list on Friday',
    );
  });

  /* The same door, reached the other way: a fresh sentence typed over a turn
     that already failed. Newest words win, always. */
  it('prefers a freshly typed sentence over an older failure', async () => {
    registerVoicePipeline(
      fakePipeline({
        process: async () => {
          throw new Error('offline');
        },
      }).impl,
    );

    await useVoiceStore.getState().submitText('buy milk');
    useVoiceStore.getState().close('ring the landlord about the boiler on Thursday morning');

    expect(useVoiceStore.getState().recovered?.text).toBe(
      'ring the landlord about the boiler on Thursday morning',
    );
  });

  it('falls back to the unanswered sentence when the box was empty', async () => {
    registerVoicePipeline(
      fakePipeline({
        process: async () => {
          throw new Error('offline');
        },
      }).impl,
    );

    await useVoiceStore.getState().submitText('book the lab for Tuesday');
    useVoiceStore.getState().close('   ');

    expect(useVoiceStore.getState().recovered?.text).toBe('book the lab for Tuesday');
  });
});

/**
 * A question the user walked away from.
 *
 * Dismissing the sheet *is* how a question is abandoned — there is no "forget
 * it" control and there should not be a second door for something this
 * destructive. But `close()` did not clear `pendingClarification`, and
 * `submitText` echoes it back on the next utterance, so the parked actions
 * outlived the sheet they were asked in. With the default `confirmMode` of
 * `irreversible` those parked actions are exactly the destructive ones.
 */
describe('an abandoned confirmation', () => {
  const PARKED = '{"v":1,"kind":"confirm","actions":[{"tool_name":"note_delete"}]}';

  /** Records what the orchestrator was actually handed on each turn. */
  function asking() {
    const echoed: (string | undefined)[] = [];
    const impl = fakePipeline({
      process: async (transcript, options) => {
        echoed.push(options?.pending);
        return {
          transcript,
          items: [],
          ...(options?.pending
            ? {}
            : { clarification: { question: 'Delete “Roof plan”?', pending: PARKED } }),
        };
      },
    }).impl;
    return { impl, echoed };
  }

  it('is not replayed by a later, unrelated yes', async () => {
    const { impl, echoed } = asking();
    registerVoicePipeline(impl);

    await useVoiceStore.getState().submitText('delete the roof plan note');
    expect(useVoiceStore.getState().pendingClarification?.pending).toBe(PARKED);

    // Interrupted: the sheet goes away, and nothing else says "forget it".
    useVoiceStore.getState().close();
    expect(useVoiceStore.getState().pendingClarification).toBeNull();

    await useVoiceStore.getState().startListening();
    await useVoiceStore.getState().submitText('sounds good');

    // Nothing parked was handed back, so `classifyConfirmation` never sees an
    // affirmation to release and the note survives.
    expect(echoed).toEqual([undefined, undefined]);
  });

  /* Answering out loud is a normal way to answer, and `startListening` is on
     that path — so it must *not* be a second place the question is dropped. */
  it('survives the user reaching for the microphone to answer it', async () => {
    const { impl, echoed } = asking();
    registerVoicePipeline(impl);

    await useVoiceStore.getState().submitText('delete the roof plan note');
    await useVoiceStore.getState().startListening();

    expect(useVoiceStore.getState().pendingClarification?.question).toBe('Delete “Roof plan”?');

    await useVoiceStore.getState().submitText('yes');
    expect(echoed).toEqual([undefined, PARKED]);
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
