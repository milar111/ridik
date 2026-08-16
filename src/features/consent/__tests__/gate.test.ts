/**
 * The gate, on its own, against the real repository.
 *
 * `pipeline.test.ts` asserts that the voice turn asks; this asserts what the
 * answer is, and it does it through the shipped settings repository over real
 * SQLite rather than a fake — because the one behaviour that matters most is
 * what a *corrupt* row decodes to, and a mock would answer whatever it was
 * told to.
 */
import { freezeClock } from '@/core/clock';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createSettingsRepository } from '@/repositories/settings';

const NOW = 1_780_000_000_000;

/* The gate reaches for `getRepositories()`, which in the app is a singleton
   built over the open database. Here it is one repository over a test file. */
const repos = { settings: null as ReturnType<typeof createSettingsRepository> | null };
jest.mock('@/repositories', () => ({
  getRepositories: () => {
    if (!repos.settings) throw new Error('database is locked');
    return { settings: repos.settings };
  },
}));

import { ASSISTANT_CONSENT_STATES, hasAnsweredConsent, mayReachProvider } from '@/llm/consent';

// After the mock, so the module under test binds to it.
import { assistantMayReachProvider, consentPatch, readAssistantConsent } from '../gate';

let t: TestDatabase;
let restoreClock: () => void;

beforeEach(() => {
  restoreClock = freezeClock(NOW);
  t = createTestDatabase();
  repos.settings = createSettingsRepository(t.db);
});

afterEach(() => {
  restoreClock();
  repos.settings = null;
  t.close();
});

/**
 * Two questions, and the difference between them is what orders the first run
 * against the one address in this app that is a verb.
 *
 * *May the words be sent* is answered only by `granted`. *Has the person been
 * asked* is answered by `declined` too — and a decline leaves a working app,
 * whose offline matcher still files a plain sentence with nothing leaving the
 * phone. `useSpeakIntent` waits on the second: `ConsentGate` is an overlay, so
 * home is live underneath it and a widget tap that fired anyway would open the
 * microphone behind a disclosure nobody has read. Waiting on the first instead
 * would leave the mic tile dead for ever on a phone that said no.
 */
describe('answered and granted are different questions', () => {
  it.each([
    ['unset', false, false],
    ['declined', false, true],
    ['granted', true, true],
  ] as const)('reads %p as may-send %p, asked %p', (consent, maySend, asked) => {
    expect(mayReachProvider(consent)).toBe(maySend);
    expect(hasAnsweredConsent(consent)).toBe(asked);
  });

  /* Neither may be looser than the other: anything that can send has, by
     definition, been asked. A fourth state added on one side only would break
     here rather than on a phone. */
  it('never lets a state send without having been asked', () => {
    for (const consent of ASSISTANT_CONSENT_STATES) {
      if (mayReachProvider(consent)) expect(hasAnsweredConsent(consent)).toBe(true);
    }
  });
});

describe('reading the decision', () => {
  it('is not permission until somebody has actually given it', async () => {
    expect(await readAssistantConsent()).toBe('unset');
    expect(await assistantMayReachProvider()).toBe(false);
  });

  it.each(['granted', 'declined'] as const)('reads back a recorded %p', async (decision) => {
    await repos.settings!.setMany(consentPatch(decision));

    expect(await readAssistantConsent()).toBe(decision);
    expect(await assistantMayReachProvider()).toBe(decision === 'granted');
  });

  /* The direction the failure has to fall. A row holding something no schema
     recognises — a hand edit, a build that shipped a fourth state — must decode
     to "never asked" and not to a value that lets a request out. */
  it('decodes a value it does not recognise as no consent', async () => {
    t.client.runSync(
      'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?,?,?)',
      ['assistantConsent', '"whatever"', NOW],
    );

    expect(await readAssistantConsent()).toBe('unset');
    expect(await assistantMayReachProvider()).toBe(false);
  });

  /* Same direction, louder: a database that will not open cannot be evidence
     that anyone agreed to anything. It must not throw either — this runs on the
     money path of every turn, and the turn still has to be answered. */
  it('treats an unopenable database as no consent rather than as a failure', async () => {
    repos.settings = null;

    await expect(readAssistantConsent()).resolves.toBe('unset');
    await expect(assistantMayReachProvider()).resolves.toBe(false);
  });
});

describe('recording the decision', () => {
  /* Three rows, written together. `setMany` is transactional, so there is no
     state where the decision landed and the timestamp did not — and the
     timestamp is the half a privacy review asks to see. */
  it('stamps the decision with the frozen clock and closes the first run', async () => {
    expect(consentPatch('granted')).toEqual({
      assistantConsent: 'granted',
      assistantConsentAt: NOW,
      onboardingComplete: true,
    });
  });

  /* Declining finishes the first run just as completely as agreeing does. The
     screen has been seen; the answer was no. */
  it('counts a refusal as an answered first run', async () => {
    const after = await repos.settings!.setMany(consentPatch('declined'));

    expect(after.assistantConsent).toBe('declined');
    expect(after.onboardingComplete).toBe(true);
    expect(after.assistantConsentAt).toBe(NOW);
  });

  /* Revocable, and the stamp moves with it: what matters is when the decision
     standing today was taken, not when the first one was. */
  it('re-stamps when the decision changes', async () => {
    await repos.settings!.setMany(consentPatch('granted', NOW));
    const after = await repos.settings!.setMany(consentPatch('declined', NOW + 60_000));

    expect(after.assistantConsent).toBe('declined');
    expect(after.assistantConsentAt).toBe(NOW + 60_000);
  });
});
