/**
 * What the two screens that quote the trial are actually reading.
 *
 * `trialLedger.ts` keeps the counter twice: the working copy in `app_settings`
 * and a durable mirror in the keychain, because on iOS the keychain outlives
 * the app and SQLite does not. `readTrialLedger()` takes the *larger* of the
 * two and heals the smaller — and it had exactly one caller, the voice turn.
 *
 * So both read-outs — the Plan row and the consent screen — read only the
 * database. Spend all 25, delete the app, reinstall: the settings row falls
 * back to 0, both screens announce a full trial, somebody decides to send their
 * data on the strength of it, and the first turn refuses.
 *
 * `mergeTrial` is the combining rule, and it is the part that is easy to get
 * subtly wrong — the first version used `durable ?? stored`, which lets a
 * keychain read that resolved to zero *replace* a settings row that knew
 * better. Every direction of that error hands out requests somebody has spent.
 */
import { mergeTrial } from '../allowance';

const stored = { requestsUsed: 18, tokensUsed: 40_000 };

describe('combining the two halves of the trial ledger', () => {
  it('keeps the stored value while the durable read is in flight', () => {
    expect(mergeTrial(undefined, stored)).toEqual(stored);
  });

  /* The reinstall case, which is the whole reason the mirror exists. */
  it('prefers the durable copy when the database has been wiped', () => {
    const merged = mergeTrial({ requestsUsed: 25, tokensUsed: 90_000 }, {
      requestsUsed: 0,
      tokensUsed: 0,
    });
    expect(merged).toEqual({ requestsUsed: 25, tokensUsed: 90_000 });
  });

  /**
   * The direction the first attempt got wrong.
   *
   * Android's keystore goes with the app's data, and a failed read resolves to
   * zero rather than throwing. `durable ?? stored` would have taken that zero
   * and handed back a trial the user had already spent.
   */
  it('never lets a lower durable copy lower the count', () => {
    expect(mergeTrial({ requestsUsed: 0, tokensUsed: 0 }, stored)).toEqual(stored);
  });

  it('takes the larger of each counter independently', () => {
    const merged = mergeTrial({ requestsUsed: 25, tokensUsed: 10 }, {
      requestsUsed: 3,
      tokensUsed: 90_000,
    });
    expect(merged).toEqual({ requestsUsed: 25, tokensUsed: 90_000 });
  });

  /**
   * `NaN` means a counter could not be read at all.
   *
   * The ledger's own rule is that an unreadable counter reads as *spent* — the
   * alternative is a way to get another 25 requests by breaking SQLite. So it
   * must never win a comparison and turn a real number into nothing.
   */
  it('lets a real number beat an unreadable one', () => {
    expect(mergeTrial({ requestsUsed: Number.NaN, tokensUsed: Number.NaN }, stored)).toEqual(stored);
    expect(
      mergeTrial(stored, { requestsUsed: Number.NaN, tokensUsed: Number.NaN }),
    ).toEqual(stored);
  });
});
