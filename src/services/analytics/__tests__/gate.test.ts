/**
 * The upload gate, as a truth table.
 *
 * `mayUploadAnalytics` is four lines and is the only thing standing between a
 * local ledger and a network request, so it gets an exhaustive test rather than
 * a representative one: every combination of the three consent states and the
 * two switch positions, asserted by name.
 *
 * The interesting row is `declined + on`. It is **true**, deliberately, and
 * that is the documented departure from "every outbound path is behind
 * `mayReachProvider`" — somebody who refused to send their words to Google may
 * still choose to send an anonymous counter, and refusing that on their behalf
 * is not more privacy-preserving, it is just less accurate about what they
 * asked for. If that ever gets changed back, this test is where the decision
 * is recorded and it should be changed here first.
 */
import {
  ASSISTANT_CONSENT_STATES,
  hasAnsweredConsent,
  mayReachProvider,
  mayUploadAnalytics,
  type AssistantConsent,
} from '@/llm/consent';

describe('the upload gate', () => {
  it('refuses every consent state while the switch is off', () => {
    for (const consent of ASSISTANT_CONSENT_STATES) {
      expect(mayUploadAnalytics({ consent, optIn: false })).toBe(false);
    }
  });

  it('refuses an unanswered disclosure even with the switch on', () => {
    // The first-run lid is still up. Nothing may leave while somebody is
    // reading the question they have not answered.
    expect(mayUploadAnalytics({ consent: 'unset', optIn: true })).toBe(false);
  });

  it('allows a granted or a declined answer once the switch is on', () => {
    expect(mayUploadAnalytics({ consent: 'granted', optIn: true })).toBe(true);
    expect(mayUploadAnalytics({ consent: 'declined', optIn: true })).toBe(true);
  });

  it('is exactly "answered and switched on", for every combination', () => {
    const table: { consent: AssistantConsent; optIn: boolean; expected: boolean }[] = [
      { consent: 'unset', optIn: false, expected: false },
      { consent: 'unset', optIn: true, expected: false },
      { consent: 'declined', optIn: false, expected: false },
      { consent: 'declined', optIn: true, expected: true },
      { consent: 'granted', optIn: false, expected: false },
      { consent: 'granted', optIn: true, expected: true },
    ];
    // Exhaustive by construction: three states times two positions.
    expect(table).toHaveLength(ASSISTANT_CONSENT_STATES.length * 2);

    for (const row of table) {
      expect(mayUploadAnalytics({ consent: row.consent, optIn: row.optIn })).toBe(row.expected);
      expect(row.expected).toBe(row.optIn && hasAnsweredConsent(row.consent));
    }
  });

  /**
   * And the departure, stated as a difference rather than as prose.
   *
   * There is exactly one state where the upload gate is open and the model gate
   * is shut. Naming it here means a future change to either function shows up
   * as a diff on this assertion instead of passing quietly.
   */
  it('differs from the model gate in exactly one state', () => {
    const differs = ASSISTANT_CONSENT_STATES.filter(
      (consent) => mayUploadAnalytics({ consent, optIn: true }) !== mayReachProvider(consent),
    );
    expect(differs).toEqual(['declined']);
  });
});
