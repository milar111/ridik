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
