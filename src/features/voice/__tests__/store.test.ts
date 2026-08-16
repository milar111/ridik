import { registerVoicePipeline, useVoiceStore, type VoicePipeline } from '../store';

/** Captures the handlers so a test can fire them late, after the user moved on. */
function fakePipeline() {
  let handlers: Parameters<VoicePipeline['listen']>[0] | null = null;
  const impl: VoicePipeline = {
    listen: async (h) => {
      handlers = h;
    },
    stopListening: async () => {},
    process: async (transcript) => ({ transcript, items: [] }),
    speak: async () => {},
    stopSpeaking: async () => {},
  };
  return { impl, fire: () => handlers! };
}

beforeEach(() => {
  useVoiceStore.getState().reset();
});

describe('voice store', () => {
  /* The recogniser keeps talking after it is stopped — cancelling it usually
     surfaces as an error a moment later. Left unguarded that late error lands
     on a store the user has already dismissed, and the mic sits there red with
     a message nobody can read, because the sheet it belonged to is closed. */
  it('ignores an error from a session the user already dismissed', async () => {
    const { impl, fire } = fakePipeline();
    registerVoicePipeline(impl);

    await useVoiceStore.getState().startListening();
    useVoiceStore.getState().close();

    fire().onError('The recogniser was cancelled.', 'aborted');

    expect(useVoiceStore.getState().status).toBe('idle');
    expect(useVoiceStore.getState().error).toBeNull();
  });

  it('ignores a transcript that arrives after the session was abandoned', async () => {
    const { impl, fire } = fakePipeline();
    registerVoicePipeline(impl);

    await useVoiceStore.getState().startListening();
    useVoiceStore.getState().close();

    fire().onFinal('book the lab for tomorrow', 0.9);

    // Never acted on: the user closed the sheet rather than sending it, and a
    // dismissed sentence must not write to the database a moment later.
    expect(useVoiceStore.getState().transcript).toBe('');
    expect(useVoiceStore.getState().status).toBe('idle');
  });

  it('still hears the session it is actually in', async () => {
    const { impl, fire } = fakePipeline();
    registerVoicePipeline(impl);

    await useVoiceStore.getState().startListening();
    fire().onPartial('remind me to');

    expect(useVoiceStore.getState().partial).toBe('remind me to');
  });

  /**
   * One turn at a time.
   *
   * Nothing used to stop a second `process()` starting while the first was
   * still waiting on the model: the Send button is enabled on a non-empty draft
   * alone, so ten taps in a second ran ten turns in parallel. Every one of them
   * checked the budget against the same counters, every one of them billed, and
   * the trial moved by one — which also meant a spent trial could be walked
   * past by firing the batch before the last increment landed.
   */
  it('will not start a second turn while one is still in flight', async () => {
    const waiting: (() => void)[] = [];
    const calls: string[] = [];
    registerVoicePipeline({
      listen: async () => {},
      stopListening: async () => {},
      process: async (transcript) => {
        calls.push(transcript);
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
        return { transcript, items: [] };
      },
      speak: async () => {},
      stopSpeaking: async () => {},
    });

    const first = useVoiceStore.getState().submitText('note the resistors');
    // Nine more taps on Send while the first is still thinking.
    await Promise.all(
      Array.from({ length: 9 }, () => useVoiceStore.getState().submitText('note the resistors')),
    );

    expect(calls).toHaveLength(1);

    waiting.shift()!();
    await first;

    // And the dock is usable again the moment the turn lands.
    const second = useVoiceStore.getState().submitText('and the capacitors');
    expect(calls).toEqual(['note the resistors', 'and the capacitors']);
    waiting.shift()!();
    await second;
  });

  it('flags a device with no recogniser so the UI can offer typing instead', async () => {
    const { impl, fire } = fakePipeline();
    registerVoicePipeline(impl);

    await useVoiceStore.getState().startListening();
    fire().onError('This device has no speech recogniser.', 'unsupported');

    expect(useVoiceStore.getState().sttUnavailable).toBe(true);
    // Not a retry: tapping the mic again on this device will fail identically.
    expect(useVoiceStore.getState().needsRetry).toBe(false);
  });
});
