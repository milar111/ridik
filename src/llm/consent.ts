/**
 * Whether the words of a request may be sent to the model, and what to say
 * when they may not.
 *
 * Ridik's promise is local-first: no account, and everything in one SQLite
 * file on the phone. All of that is true, and all of it is true of the
 * *storage* — including the usage ledger, which is counted into that same file
 * and stays there unless the user switches the upload on. The assistant is the one thing that is not — turning "remind me to
 * call Ivo at 4, and note that the lab needs 10k resistors" into three writes
 * takes a language model, and the only language model in this build runs on
 * Google's machines. The transcript leaves the device. Nothing in the app used
 * to say so.
 *
 * That is a launch blocker rather than a preference. Apple's Guideline 5.1.2(i)
 * requires explicit permission before personal data goes to a third-party AI,
 * and requires that the third party be *named*; Google Play's Data Safety form
 * and GDPR's transparency duty want the same disclosure in the same words. The
 * common technical rejection is a consent screen that appears after the first
 * request has already been made, which is why this is a vocabulary module with
 * a gate in front of `clientForTurn()` rather than a screen with a checkbox.
 *
 * Three states, not a boolean. "Has not been asked yet" and "was asked and said
 * no" are the same as far as the gate is concerned and completely different
 * everywhere else: the first one opens the first-run screen, the second one
 * must never open it again. A boolean collapses them and the app either nags a
 * person who already declined or silently treats silence as a yes.
 *
 * Pure, and imported by `src/repositories/settings.ts` for exactly the reason
 * `./confirm.ts` is: the key's declared type and the words that describe it
 * should be one file, and the repositories must stay loadable under plain Node.
 */

/** Whether the assistant may send this user's words to its provider. */
export type AssistantConsent =
  /** Never asked. The first-run screen is waiting. */
  | 'unset'
  /** Asked and agreed. The only value that lets a billable call be made. */
  | 'granted'
  /** Asked and refused. Everything local still works; nothing is sent. */
  | 'declined';

export const ASSISTANT_CONSENT_STATES = ['unset', 'granted', 'declined'] as const;

export const DEFAULT_ASSISTANT_CONSENT: AssistantConsent = 'unset';

/**
 * The third party, by name.
 *
 * Named in one place because the same word has to appear in the disclosure, in
 * the refusal notice and in the Settings row, and a disclosure that names a
 * provider the notice does not is worse than either on its own. Both paths to
 * a model end here: a personal build posts to `generativelanguage.googleapis.com`
 * with the user's own key, and a hosted build posts to the operator's backend,
 * which posts to the same place.
 */
export const ASSISTANT_PROVIDER = 'Google';

/**
 * The second third party, by name.
 *
 * `src/voice/whisper.ts` posts the recording to `api.openai.com`, and the
 * recipient of the most sensitive payload this app has was never named
 * anywhere: the screen said "the optional Whisper transcription", which is a
 * model and not a company, so a reader had no way to know their audio goes to
 * OpenAI. Naming the third party is the specific thing Guideline 5.1.2(i) asks
 * for, and one grant that quietly covers two recipients is only informed if
 * both are on the screen the grant was given on.
 */
export const WHISPER_PROVIDER = 'OpenAI';

/*
  There is no `PUSH_PROVIDER` any more, and its absence is the point.

  It was `'OneSignal'`, and it belonged here for a good reason: the daily
  briefing push was composed by a dashboard from tags this device published, and
  two of those tags were `composeVisual`'s own sentences — real event titles,
  task titles, habit names, the names of people in the CRM. That is content
  leaving the phone to a named company, so it sat on the same screen behind the
  same grant.

  The SDK is gone (see `services/notifications/index.ts` for what linking it
  cost), so the recipient is gone, so the sentence naming it is gone. That
  ordering matters: a disclosure that keeps naming a company you no longer send
  anything to is not harmlessly out of date, it is inaccurate about where data
  goes, which is the one thing this file exists to be right about.

  `consent-screen.test.tsx` enumerates every `*_PROVIDER` this module exports and
  fails if one is not on the screen — so removing the constant is what keeps that
  test honest rather than something the test had to be told about.
*/

/**
 * The fourth recipient, and the only one that is us.
 *
 * When — and only when — the user switches "Help improve Ridik" on, the counts
 * they can read on the Usage screen are posted to the operator's own backend:
 * the same server a hosted build already sends every turn to, so this widens a
 * disclosure that exists rather than opening a new one. It is named anyway,
 * because "our own server" is still somewhere the data goes, and a reader
 * deciding whether to trust this app should not have to infer that from the
 * absence of a company name.
 *
 * A third-party analytics SDK was considered and rejected for exactly this
 * reason — see `notes/ONBOARDING-SPEC.md` §15.1. Nothing in the payload
 * identifies a device, an install or a person.
 */
export const ANALYTICS_PROVIDER = "Ridik's own server";

/**
 * The fifth, which exists so a crash on somebody's phone is not invisible.
 *
 * Behind the same single switch as the counts and off with it. A crash report
 * is a stack trace and the app's own state, not a note or a transcript — but it
 * is a third party receiving data from this device, which is the only test that
 * decides whether a name belongs on the consent screen.
 */
export const CRASH_PROVIDER = 'Sentry';

/**
 * The sixth, and the one that is not optional.
 *
 * A purchase reaches RevenueCat, and through it Apple or Google: the receipt,
 * the product, the price, and an anonymous identifier RevenueCat mints for the
 * install. Nobody switches this on and nobody can switch it off while the app
 * sells anything, which is exactly why it was missing from the screen for so
 * long — the disclosure grew by asking "what did the user opt into?", and the
 * right question is "what leaves?".
 *
 * It is not behind `mayReachProvider`; a store build talks to the store. It is
 * named anyway, because the rule is that every recipient is on the screen, not
 * that every *optional* recipient is.
 */
export const STORE_PROVIDER = 'RevenueCat';

/** The one route that explains what is sent and takes the decision. */
export const CONSENT_ACTION = { label: 'What gets sent', href: '/consent' } as const;

/** True only for `granted`. Written as a function so no call site tests a string. */
export function mayReachProvider(consent: AssistantConsent): boolean {
  return consent === 'granted';
}

/**
 * Whether the first-run question has been answered at all — either way.
 *
 * A different question from `mayReachProvider`, and the difference is the whole
 * reason both exist. *May the words be sent* is answered only by `granted`;
 * *has the person been asked* is answered by `declined` too, and someone who
 * declined has a working app — the offline matcher still files a note, a task
 * or an expense from a plain sentence, with nothing leaving the phone.
 *
 * It is what `ConsentGate` draws its lid on, and therefore what
 * `useSpeakIntent` has to wait for: while the answer is `unset` a full-screen
 * disclosure is covering home, and a microphone opened underneath it would be
 * listening to somebody who is still reading the question. A widget tap must
 * not be the way around a gate the app's own mic button cannot get around.
 * Holding on `granted` instead would have been the other, worse mistake: the
 * mic tile would be dead for ever on a phone that declined, on a rung of the
 * app that never needed the network.
 */
export function hasAnsweredConsent(consent: AssistantConsent): boolean {
  return consent !== 'unset';
}

/**
 * Whether the counts and crash reports may be uploaded.
 *
 * **A deliberate, documented departure from "every outbound path is behind
 * `mayReachProvider`".** Requiring `granted` would mean that declining to send
 * *your words to Google* also refuses an anonymous counter with no identity in
 * it — which is a different decision from the one the person took, and refusing
 * it on their behalf is not more privacy-preserving, it is just less accurate
 * about what they asked for.
 *
 * What the invariant actually protects is kept in full, and that is the part to
 * check when reading this: no recipient escapes the disclosure. The disclosure
 * must have been *read and answered* (`hasAnsweredConsent`), both recipients
 * are named on it (`ANALYTICS_PROVIDER`, `CRASH_PROVIDER`), and the switch is
 * off until the person turns it on — so this path is strictly harder to open
 * than the three that use `mayReachProvider`, not easier.
 *
 * If the strict reading is ever preferred, change `hasAnsweredConsent` to
 * `mayReachProvider` in this one function; nothing else moves.
 */
export function mayUploadAnalytics(input: {
  consent: AssistantConsent;
  optIn: boolean;
}): boolean {
  return input.optIn === true && hasAnsweredConsent(input.consent);
}

/**
 * What the user is told on a turn that was answered offline because consent is
 * missing.
 *
 * Three things, in this order, and the middle one is the one people assume is
 * false: what did not happen, that the app still works, and what changes it.
 * Never an apology and never a warning — nothing went wrong, and the person who
 * declined chose this.
 */
export function consentNotice(consent: AssistantConsent): string {
  if (consent === 'declined') {
    return (
      `Ridik is keeping your words on this phone, so nothing went to ${ASSISTANT_PROVIDER}. ` +
      'It still hears you and still files simple phrases as notes, tasks and events. ' +
      'Turn the assistant on to get the rest.'
    );
  }
  return (
    `Ridik has not been told it may send your words to ${ASSISTANT_PROVIDER}, ` +
    'so it answered on its own. Read what gets sent and decide.'
  );
}
