/**
 * "Start listening" as an address.
 *
 * Every entry point this app has paid for — five widgets on each platform, the
 * launcher long-press, a Control Center button, a Quick Settings tile — could
 * only ever open a screen you *read*. The one thing the product is for had no
 * URL, so none of them could ask for it, and the single most repeated line in
 * five-star reviews of everything in this category is capture at the instant the
 * thought exists, named at the entry point rather than at the app.
 *
 * `ridik:///?speak=1` is that address. It is home with a flag on it, not a route
 * of its own, because listening is not a place: you end up on the same screen
 * either way, and a `/speak` route would have to bounce you off itself on every
 * launch (see `app/unlock.tsx` for what that costs).
 *
 * The whole difficulty is in firing it *once*. A parameter in a URL is not an
 * event — it is a value that stays true — so the naive read fires again on every
 * re-render, again when you come Back from the menu, and again every time the OS
 * resumes the app with the same URL still set. It has to be consumed, and it has
 * to be consumed only when there is something on the other end to consume it:
 * these entry points produce cold launches almost exclusively, and a cold launch
 * is precisely when the recogniser has not been registered yet.
 */
import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useLocalSearchParams, useNavigation, type Href } from 'expo-router';

import { createLogger } from '@/core/logger';
import { useVoiceStore } from './store';

const log = createLogger('speak-intent');

/** The query parameter. One name, spelled once, used by four native surfaces. */
export const SPEAK_PARAM = 'speak';

/** What a caller sets it to. Anything truthy works; this is what we emit. */
export const SPEAK_VALUE = '1';

/**
 * The deep link, for the surfaces that cannot import any of this.
 *
 * A WidgetKit extension links neither the app nor React Native and an Android
 * widget is XML replayed by the launcher, so both hold this string as a literal
 * of their own — `Route.speak` in `RidikElements.swift`, `SPEAK_TARGET` in
 * `RidikCells.kt`. `src/features/voice/__tests__/speak-intent.test.tsx` reads
 * those files and fails if any of the copies drift, which is the only mechanism
 * available: nothing about a wrong URL fails at build time, and a widget that
 * opens the wrong screen looks like a design decision.
 */
export const SPEAK_DEEP_LINK = `ridik:///?${SPEAK_PARAM}=${SPEAK_VALUE}`;

/** The same intent from inside the app, where there is a router to hand. */
export function speakHref(): Href {
  return { pathname: '/', params: { [SPEAK_PARAM]: SPEAK_VALUE } } as Href;
}

/**
 * Whether a set of route params is asking for the microphone.
 *
 * A repeated query parameter arrives as an array, and the parameter is *cleared*
 * by writing an empty string rather than by deleting it — expo-router merges
 * what you hand `setParams`, so removal is not a thing you can rely on. Both of
 * those have to read as "no".
 */
export function wantsSpeak(params: Record<string, string | string[] | undefined>): boolean {
  const raw = params[SPEAK_PARAM];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') return false;
  return value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * True once the app is in a state where asking for the microphone can succeed.
 *
 * Two conditions, and both of them are failures that have to be waited out
 * rather than reported:
 *
 *  - **The pipeline is registered.** It is a bootstrap step, and an intent from
 *    a widget arrives while that bootstrap is still running. Firing early gets
 *    "Voice is still starting up." — an error message where the whole product
 *    should have been, on the only kind of launch these entry points make.
 *  - **The app is actually foregrounded.** Both platforms hand the URL over
 *    before the app is active, and a recogniser started against an inactive
 *    audio session fails — on iOS by throwing, on Android by returning silence.
 *    The microphone permission prompt is the same story: it is requested by the
 *    capture ladder itself (`src/voice/index.ts` → `ensurePermissions`), and
 *    what makes that prompt appear rather than be dropped is that there is a
 *    foregrounded app to draw it over.
 */
export function useVoiceReady(): boolean {
  const pipelineReady = useVoiceStore((s) => s.pipelineReady);
  const [active, setActive] = useState(() => isForeground(AppState.currentState));

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setActive(isForeground(next)));
    return () => sub.remove();
  }, []);

  return pipelineReady && active;
}

/**
 * Whether the app is *not known to be away*, which is a different question from
 * whether it is active.
 *
 * `AppState.currentState` is `unknown` on Android until the first lifecycle
 * callback lands, and `undefined` under the test runner. Waiting for a positive
 * `'active'` therefore means waiting forever on whichever platform happens not
 * to have answered yet — a gate that fails closed on an ambiguous reading is a
 * feature that silently does nothing. Only the two states that genuinely say
 * "there is no foreground to draw a permission prompt over or open an audio
 * session in" block, and both of them are followed by a change event.
 */
function isForeground(state: AppStateStatus | null | undefined): boolean {
  return state !== 'background' && state !== 'inactive';
}

/** What `navigation.setParams` is, once the route's own parameter type is out of the way. */
type ParamSetter = (params: Record<string, string>) => void;

export type SpeakIntentOptions = {
  /**
   * Whether the first-run consent question has been answered — either way.
   *
   * `ConsentGate` draws a full-screen disclosure over the navigator for as long
   * as that answer is `unset`, and home is mounted and live *underneath* it.
   * Without this the one entry point that is a verb would be the one way past
   * the one screen the app is not allowed to skip: a widget tap on a fresh
   * install would open the microphone behind the lid, and start recording
   * somebody who is still reading the question. That is the ordering a reviewer
   * checks, so it is a parameter of this hook rather than a rule kept in
   * `app/index.tsx`.
   *
   * **Answered, not granted.** Someone who declined has a working app — the
   * offline matcher still turns "note the resistors" into a note with nothing
   * leaving the phone — so gating on `granted` would leave their mic tile
   * permanently dead on a rung that never needed the network. `hasAnsweredConsent`
   * in `@/llm/consent` is the shared spelling of that distinction.
   *
   * Held, never dropped: the flag stays in the URL and fires the moment the
   * question is answered, which is what somebody who tapped a mic tile expects.
   * Defaulting to `true` is deliberate — this is a *gate*, and a gate whose
   * input is missing must not be the thing that decides the app has no consent.
   */
  consentAnswered?: boolean;
};

/**
 * Reads the flag off the URL and starts one listening session.
 *
 * The guard is a ref rather than a piece of state, and it is set *before* the
 * asynchronous work, because two renders can happen inside one microtask and
 * anything settled asynchronously would let both through.
 *
 * The parameter is then cleared, which is what makes the three re-entry paths
 * safe at once: a re-render sees nothing, coming Back from the menu onto a
 * screen that never unmounted sees nothing, and a resume that redelivers no new
 * URL sees nothing. A resume that *does* redeliver the URL — a second tap on the
 * widget — is a second intent and correctly fires again.
 */
export function useSpeakIntent(options: SpeakIntentOptions = {}): void {
  const { consentAnswered = true } = options;
  // Untyped on purpose: with typed routes on, the generic here is a *route*
  // name, and home has no declared parameters for this one to be among.
  const params = useLocalSearchParams();
  /**
   * The route's *own* navigator, and not `useRouter().setParams`.
   *
   * They are not two spellings of the same call. `router.setParams` is
   * expo-router's global setter — it asserts the navigator is ready and then
   * writes to whichever route is *focused*, which is not necessarily this one.
   * The flag is read locally (`useLocalSearchParams` is home's own params) and
   * was being cleared globally, so any moment where home is mounted but not
   * focused wrote `speak=''` onto some other screen: home kept `speak='1'`,
   * `requested` never went false, the re-arm below was unreachable, and
   * `handled.current` stayed true for the rest of the process. Every later
   * widget mic, Quick Settings tile and Control Center tap then resolved to
   * identical params, changed nothing and silently did nothing, with nothing
   * logged. Reachable on a plain cold launch from the tile: the pipeline is a
   * bootstrap step behind migrations, and OneSignal replays a cached launch tap
   * in that window, so /tasks can be on top when the intent finally becomes
   * ready.
   */
  const navigation = useNavigation();
  const start = useVoiceStore((s) => s.startListening);
  // Three conditions, all of them waited out rather than reported: a registered
  // recogniser, a foregrounded app, and a first run that has been answered. The
  // last one is the only one that is about permission rather than readiness,
  // and it is the reason the flag is *consumed* on firing and not before — an
  // intent cleared while the consent lid was still up would be an intent lost.
  const ready = useVoiceReady() && consentAnswered;

  const requested = wantsSpeak(params);
  const handled = useRef(false);

  useEffect(() => {
    if (!requested) {
      // Re-armed for the next arrival. Nothing can fire while the flag is off,
      // so this is safe to do unconditionally and is the only place it happens.
      handled.current = false;
      return;
    }
    if (handled.current || !ready) return;
    handled.current = true;
    // The microphone first, the bookkeeping second. Clearing before starting
    // meant a `setParams` that threw — the global one asserts the navigator is
    // ready and does throw when it is not — consumed the intent and never
    // opened the microphone, which is the one failure this whole module exists
    // to avoid.
    void start();
    try {
      // Cast at the call rather than on the hook's result, so nothing else
      // about the navigation object loses its types: `setParams` is typed
      // against the route's *declared* parameters and home declares none —
      // `speak` is a flag four native surfaces put on the URL, not a segment
      // expo-router generated a type for.
      (navigation.setParams as unknown as ParamSetter)({ [SPEAK_PARAM]: '' });
    } catch (error) {
      // The session has started; the flag is merely stale. Worth a line,
      // because the next arrival of the same URL will not re-render anything.
      log.warn('could not clear the speak flag', error);
    }
  }, [requested, ready, navigation, start]);
}
