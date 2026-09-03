/**
 * The keeping place, across the app being killed.
 *
 * `Unsent.tsx` states the scenario itself: "the user is mid-corridor, the model
 * timed out, and the paragraph they dictated has to still be there when they
 * get somewhere they can look at a screen." That window is exactly the one in
 * which iOS and Android reclaim a backgrounded app, and the slot lived in
 * zustand and nowhere else — so it survived every failure it was designed for
 * and not the ordinary one.
 *
 * The filesystem is faked rather than the module: what has to be pinned is that
 * a write happens on every change and that a restore is refused when it would
 * overwrite something newer.
 */
import { freezeClock } from '@/core/clock';

// `mock`-prefixed so the hoisted `jest.mock` factory below may reach them.
const mockFiles = new Map<string, string>();
const mockDirectories = new Set<string>();

jest.mock('@/startup/bootstrap', () => ({ registerBootstrapStep: jest.fn() }));

jest.mock('expo-file-system', () => {
  class FakeDirectory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : String((p as { uri: string }).uri))).join('/');
    }
    get exists() {
      return mockDirectories.has(this.uri);
    }
    create() {
      mockDirectories.add(this.uri);
    }
  }
  class FakeFile {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : String((p as { uri: string }).uri))).join('/');
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    create() {
      if (!mockFiles.has(this.uri)) mockFiles.set(this.uri, '');
    }
    write(content: string) {
      mockFiles.set(this.uri, content);
    }
    textSync() {
      const value = mockFiles.get(this.uri);
      if (value === undefined) throw new Error('no such file');
      return value;
    }
    delete() {
      mockFiles.delete(this.uri);
    }
  }
  return { Directory: FakeDirectory, File: FakeFile, Paths: { document: 'doc' } };
});

import {
  clearKeptTranscript,
  installTranscriptKeeper,
  readKeptTranscript,
  resetTranscriptKeeper,
  writeKeptTranscript,
} from '../keep';
import { useVoiceStore } from '../store';

const AT = Date.UTC(2026, 7, 11, 9, 0, 0);
let restoreClock: () => void;

beforeEach(() => {
  restoreClock = freezeClock(AT);
  mockFiles.clear();
  mockDirectories.clear();
  resetTranscriptKeeper();
  useVoiceStore.getState().reset();
  useVoiceStore.getState().discardRecovered();
});

afterEach(() => restoreClock());

describe('the kept transcript on disk', () => {
  it('round-trips a sentence and the reason it was kept', () => {
    writeKeptTranscript({ text: 'ring the landlord about the boiler', at: AT, reason: 'failed' });

    expect(readKeptTranscript()).toEqual({
      text: 'ring the landlord about the boiler',
      at: AT,
      reason: 'failed',
    });
  });

  it('is nothing at all before anything has been kept', () => {
    expect(readKeptTranscript()).toBeNull();
  });

  /* A half-written or hand-edited file must read as "nothing kept", never as a
     crash on the startup path and never as a truncated sentence offered back
     as if it were what the user said. */
  it('reads anything that is not what we wrote as nothing', () => {
    for (const junk of ['', 'not json', '[]', '{}', '{"text":"   "}', 'null']) {
      mockFiles.set('doc/voice/unsent.json', junk);
      expect(readKeptTranscript()).toBeNull();
    }
  });

  it('takes the slot with it when the file is cleared', () => {
    writeKeptTranscript({ text: 'log forty on groceries', at: AT, reason: 'unsent' });
    writeKeptTranscript(null);

    expect(readKeptTranscript()).toBeNull();
  });
});

describe('the keeper, wired to the store', () => {
  it('mirrors every change to the slot', () => {
    installTranscriptKeeper();

    useVoiceStore.getState().keepDraft('note that the lab needs 10k resistors');
    expect(readKeptTranscript()?.text).toBe('note that the lab needs 10k resistors');

    useVoiceStore.getState().discardRecovered();
    expect(readKeptTranscript()).toBeNull();
  });

  /**
   * "Edit" moves the words out of the slot and into the composer — and
   * the composer is React state, which dies with the process exactly like the
   * slot used to. Deleting the file there would make the *recovery* button the
   * tap that loses the sentence.
   */
  it('holds the file while the words are sitting in the composer', () => {
    installTranscriptKeeper();
    useVoiceStore.getState().keepDraft('the whole paragraph');

    useVoiceStore.getState().recoverTranscript();

    expect(useVoiceStore.getState().recovered).toBeNull();
    expect(readKeptTranscript()?.text).toBe('the whole paragraph');
  });

  /* And it lets go the moment a turn actually lands, which is the only signal
     the branch above cannot see: a sentence sent from the composer was already
     out of the slot, so nothing about `recovered` changes. */
  it('lets go once a turn has landed', () => {
    installTranscriptKeeper();
    useVoiceStore.getState().keepDraft('the whole paragraph');
    useVoiceStore.getState().recoverTranscript();

    useVoiceStore.setState({ outcome: { transcript: 'the whole paragraph', items: [] } });

    expect(readKeptTranscript()).toBeNull();
  });

  /* A turn that never reached the model is not a landing, and neither is
     somebody else's sentence succeeding while this one still waits. */
  it('does not let go for a turn that never ran', () => {
    installTranscriptKeeper();
    useVoiceStore.getState().keepDraft('the whole paragraph');
    useVoiceStore.getState().recoverTranscript();

    useVoiceStore.setState({
      outcome: { transcript: 'the whole paragraph', items: [], failed: true },
    });

    expect(readKeptTranscript()?.text).toBe('the whole paragraph');
  });

  it('does not let go while a different sentence is still waiting', () => {
    installTranscriptKeeper();
    useVoiceStore.getState().keepDraft('remind me to renew the parking permit');

    useVoiceStore.setState({ outcome: { transcript: 'what is next', items: [] } });

    expect(readKeptTranscript()?.text).toBe('remind me to renew the parking permit');
  });

  it('puts the words back after the process died', () => {
    writeKeptTranscript({ text: 'the whole paragraph', at: AT, reason: 'failed' });

    installTranscriptKeeper();

    expect(useVoiceStore.getState().recovered).toEqual({
      text: 'the whole paragraph',
      at: AT,
      reason: 'failed',
    });
  });

  /* Bootstrap is async and the navigator is already mounted under it, so a
     turn can have happened first. Whatever this session produced is newer than
     anything on disk, by definition. */
  it('never overwrites something this session already kept', () => {
    writeKeptTranscript({ text: 'the old one', at: AT - 60_000, reason: 'failed' });
    useVoiceStore.getState().keepDraft('the one from this session');

    installTranscriptKeeper();

    expect(useVoiceStore.getState().recovered?.text).toBe('the one from this session');
  });

  /**
   * "Delete all data" empties SQLite and nothing else — which is true of the
   * saved backups too, and now said outright on that screen. A backup is a file
   * the user asked for and can see; this one they never asked for, so erasing
   * has to take it rather than leave a dictated paragraph on a phone somebody
   * is about to sell.
   */
  it('is taken by an erase', () => {
    installTranscriptKeeper();
    useVoiceStore.getState().keepDraft('everything I said this morning');

    clearKeptTranscript();

    expect(useVoiceStore.getState().recovered).toBeNull();
    expect(readKeptTranscript()).toBeNull();
  });
});
