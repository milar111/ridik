/**
 * Where the free trial's counters live, and what it takes to reset them.
 *
 * The trial is the one budget in the app that is *lifetime*, which makes its
 * storage part of the control rather than an implementation detail. It was a
 * single SQLite row, and there were three ways to zero it: erase all data,
 * a Reset button on a screen a deep link reaches, and reinstalling the app.
 * These tests are about the third, and about the read-modify-write that let
 * concurrent turns each spend the same request.
 */
const durable = new Map<string, string>();
const mockGetItem = jest.fn(async (key: string) => durable.get(key) ?? null);
const mockSetItem = jest.fn(async (key: string, value: string) => {
  durable.set(key, value);
});

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  getItemAsync: (key: string, ...rest: unknown[]) => mockGetItem(key, ...(rest as [])),
  setItemAsync: (key: string, value: string, ...rest: unknown[]) =>
    mockSetItem(key, value, ...(rest as [])),
}));

let mockStored: Record<string, number>;
let mockBroken = false;

jest.mock('@/repositories', () => ({
  getRepositories: () => {
    if (mockBroken) throw new Error('database is locked');
    return {
      settings: {
        get: async (key: string) => mockStored[key],
        set: async (key: string, value: number) => {
          mockStored[key] = value;
          return value;
        },
        // The real one does the read and the write inside one queued job. Here
        // it is genuinely atomic because nothing awaits inside it, which is the
        // property the pipeline is relying on.
        bump: async (key: string, by: number) => {
          mockStored[key] = Math.max(0, (mockStored[key] ?? 0) + by);
          return mockStored[key];
        },
      },
    };
  },
}));

import { chargeTrial, readTrialLedger } from '../trialLedger';

const REQUESTS = 'ridik.trial.requestsUsed';
const TOKENS = 'ridik.trial.tokensUsed';

beforeEach(() => {
  durable.clear();
  mockStored = { llmTrialRequestsUsed: 0, llmTrialTokensUsed: 0 };
  mockBroken = false;
});

describe('reading the ledger', () => {
  it('reads the working copy when nothing has gone missing', async () => {
    mockStored.llmTrialRequestsUsed = 7;
    mockStored.llmTrialTokensUsed = 52_000;

    await expect(readTrialLedger()).resolves.toEqual({ requestsUsed: 7, tokensUsed: 52_000 });
  });

  /* The reinstall case, and the "erase everything" case if the row exemption in
     `db/wipe.ts` were ever removed: SQLite is empty, the Keychain is not. */
  it('takes the durable copy when the database has been cleared', async () => {
    durable.set(REQUESTS, '25');
    durable.set(TOKENS, '600000');

    await expect(readTrialLedger()).resolves.toEqual({
      requestsUsed: 25,
      tokensUsed: 600_000,
    });
  });

  it('heals the working copy so the next charge counts from the right place', async () => {
    durable.set(REQUESTS, '25');

    await readTrialLedger();

    expect(mockStored.llmTrialRequestsUsed).toBe(25);
  });

  /* Neither store may be lowered by clearing the other, in either direction. */
  it('takes the larger of the two, never the newer', async () => {
    mockStored.llmTrialRequestsUsed = 20;
    durable.set(REQUESTS, '3');

    await expect(readTrialLedger()).resolves.toMatchObject({ requestsUsed: 20 });
  });

  /* An unreadable database must not read as a fresh trial: it is otherwise a
     way to get another 25 requests by breaking SQLite. `NaN` is what the
     resolver reads as spent. */
  it('reports an unreadable database as spent rather than as unspent', async () => {
    mockBroken = true;

    const ledger = await readTrialLedger();

    expect(Number.isFinite(ledger.requestsUsed)).toBe(false);
    expect(Number.isFinite(ledger.tokensUsed)).toBe(false);
  });

  it('survives a keychain that will not open', async () => {
    mockGetItem.mockRejectedValueOnce(new Error('keychain locked'));
    mockStored.llmTrialRequestsUsed = 4;

    await expect(readTrialLedger()).resolves.toMatchObject({ requestsUsed: 4 });
  });

  it('ignores nonsense in the durable copy rather than trusting it', async () => {
    durable.set(REQUESTS, 'not a number');
    mockStored.llmTrialRequestsUsed = 4;

    await expect(readTrialLedger()).resolves.toMatchObject({ requestsUsed: 4 });
  });
});

describe('charging the trial', () => {
  it('counts the turn and what it billed, in both units', async () => {
    await chargeTrial({ requests: 1, tokens: 7_360 });

    await expect(readTrialLedger()).resolves.toEqual({ requestsUsed: 1, tokensUsed: 7_360 });
  });

  /* The lost update. Ten taps on Send in one second ran ten turns in parallel;
     all ten read the same number and all ten wrote it back plus one, so ten
     billable calls cost one request off a 25-request budget. */
  it('loses nothing when ten turns are charged at once', async () => {
    await Promise.all(
      Array.from({ length: 10 }, () => chargeTrial({ requests: 1, tokens: 7_360 })),
    );

    await expect(readTrialLedger()).resolves.toEqual({
      requestsUsed: 10,
      tokensUsed: 73_600,
    });
  });

  it('mirrors the running total to the durable copy, not the increment', async () => {
    await chargeTrial({ requests: 1, tokens: 100 });
    await chargeTrial({ requests: 1, tokens: 100 });

    expect(durable.get(REQUESTS)).toBe('2');
    expect(durable.get(TOKENS)).toBe('200');
  });

  /* It runs after the model has already answered. Losing the count is bad;
     losing the user's turn on top of it is worse. */
  it('never throws when neither store will take the write', async () => {
    mockBroken = true;
    mockSetItem.mockRejectedValue(new Error('keychain locked'));

    await expect(chargeTrial({ requests: 1, tokens: 10 })).resolves.toBeUndefined();

    mockSetItem.mockReset();
    mockSetItem.mockImplementation(async (key: string, value: string) => {
      durable.set(key, value);
    });
  });

  it('does nothing at all for an empty charge', async () => {
    await chargeTrial({ requests: 0, tokens: 0 });
    expect(mockSetItem).not.toHaveBeenCalled();
    expect(mockStored.llmTrialRequestsUsed).toBe(0);
  });
});
