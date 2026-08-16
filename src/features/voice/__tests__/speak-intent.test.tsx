/**
 * The one address in this app that is a verb, and the guard that makes it fire
 * exactly once.
 *
 * Two halves, and the second is the one that cannot be caught any other way:
 *
 *  - The hook. A query parameter is a *value*, not an event, so the naive read
 *    starts a listening session on every re-render, again on the way Back from
 *    the menu, and again every time the OS resumes the app with the same URL
 *    still set. Each of those is a test here.
 *  - The four copies of the string. A WidgetKit extension links neither the app
 *    nor React Native, and an Android widget is XML replayed by the launcher, so
 *    the URL exists once in TypeScript, once in Swift, once in Kotlin and once
 *    as a route this app has to match. Nothing about a wrong one fails at build
 *    time — the widget builds, ships, and opens a screen that looks chosen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import {
  PUSH_BLOCKED_PARAMS,
  resolvePushHref,
} from '@/services/notifications/briefingPush';

import {
  SPEAK_DEEP_LINK,
  SPEAK_PARAM,
  speakHref,
  useSpeakIntent,
  wantsSpeak,
} from '../speakIntent';
import { registerVoicePipeline, useVoiceStore, type VoicePipeline } from '../store';

/* The route's own setter and the global one, kept apart on purpose: they are
   not two spellings of the same call, and the bug this file guards was writing
   the clear through the second one. */
const mockSetParams = jest.fn();
const mockGlobalSetParams = jest.fn();
const mockNavigate = jest.fn();
let mockParams: Record<string, string | string[]> = {};

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useNavigation: () => ({ setParams: mockSetParams }),
  useRouter: () => ({
    setParams: mockGlobalSetParams,
    navigate: mockNavigate,
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
}));

const listen = jest.fn(async () => {});
const pipeline: VoicePipeline = {
  listen,
  stopListening: async () => {},
  process: async (transcript) => ({ transcript, items: [] }),
  speak: async () => {},
  stopSpeaking: async () => {},
};

function Harness({ consentAnswered }: { consentAnswered?: boolean }) {
  useSpeakIntent(consentAnswered === undefined ? {} : { consentAnswered });
  return <Text>home</Text>;
}

beforeEach(() => {
  listen.mockClear();
  mockSetParams.mockReset();
  mockGlobalSetParams.mockReset();
  mockNavigate.mockReset();
  mockParams = {};
  useVoiceStore.setState({ pipelineReady: false });
});

describe('reading the flag', () => {
  it('accepts what the four entry points actually send', () => {
    expect(wantsSpeak({ speak: '1' })).toBe(true);
    expect(wantsSpeak({ speak: 'true' })).toBe(true);
  });

  it('reads a repeated parameter, which arrives as an array', () => {
    expect(wantsSpeak({ speak: ['1', '1'] })).toBe(true);
  });

  /* The flag is *cleared* by writing an empty string rather than by deleting
     it: `setParams` merges what you hand it, so removal is not something a
     caller can rely on. An empty value therefore has to read as "no". */
  it('reads a cleared flag, an absent one and an explicit no as no', () => {
    expect(wantsSpeak({ speak: '' })).toBe(false);
    expect(wantsSpeak({})).toBe(false);
    expect(wantsSpeak({ speak: '0' })).toBe(false);
    expect(wantsSpeak({ speak: 'false' })).toBe(false);
  });
});

describe('the speak intent', () => {
  it('starts one listening session and takes the flag out of the URL', async () => {
    registerVoicePipeline(pipeline);
    mockParams = { speak: '1' };

    await render(<Harness />);

    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    expect(mockSetParams).toHaveBeenCalledWith({ [SPEAK_PARAM]: '' });
  });

  /**
   * The failure this exists to prevent: these entry points produce cold
   * launches almost exclusively, and on a cold launch the pipeline is a
   * bootstrap step that has not run yet. Firing early is not a slower start —
   * it is "Voice is still starting up." where the whole product should be.
   */
  it('waits for the recogniser rather than failing into a cold pipeline', async () => {
    mockParams = { speak: '1' };

    await render(<Harness />);
    expect(listen).not.toHaveBeenCalled();
    expect(mockSetParams).not.toHaveBeenCalled();

    await act(async () => {
      registerVoicePipeline(pipeline);
    });

    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
  });

  /**
   * The ordering between the two entry points that arrived together: the
   * consent lid is drawn *over* home, which stays mounted underneath, so an
   * unheld intent would open the microphone behind a disclosure nobody has read
   * yet — a widget tap as the one way past the one screen that cannot be
   * skipped.
   *
   * Held, not dropped: the flag stays in the URL, so the tap is honoured the
   * moment the question is answered rather than thrown away for having been
   * early. Nothing is consumed while it waits, which is what makes that safe.
   */
  it('holds the intent behind an unanswered consent screen, then honours it', async () => {
    registerVoicePipeline(pipeline);
    mockParams = { speak: '1' };

    const view = await render(<Harness consentAnswered={false} />);
    expect(listen).not.toHaveBeenCalled();
    // Nothing spent while it waits — clearing the flag under the lid would
    // lose the tap outright.
    expect(mockSetParams).not.toHaveBeenCalled();

    await view.rerender(<Harness consentAnswered />);
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
  });

  /**
   * Back-navigation and a resume with the same URL are the same thing to the
   * router: the screen never unmounted and its params never changed. Both are
   * covered by consuming the flag, which is what this asserts — the second
   * render sees the URL the first one left behind.
   */
  it('does not fire again when the screen is returned to', async () => {
    registerVoicePipeline(pipeline);
    mockParams = { speak: '1' };

    const view = await render(<Harness />);
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));

    // What `setParams` did, as the router would report it afterwards.
    mockParams = { speak: '' };
    await view.rerender(<Harness />);
    await act(async () => {});

    expect(listen).toHaveBeenCalledTimes(1);
  });

  /* And a genuine second tap is a genuine second session. The guard has to
     re-arm, or the mic works once per launch. */
  it('fires again when the flag arrives a second time', async () => {
    registerVoicePipeline(pipeline);
    mockParams = { speak: '1' };

    const view = await render(<Harness />);
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));

    mockParams = { speak: '' };
    await view.rerender(<Harness />);

    mockParams = { speak: '1' };
    await view.rerender(<Harness />);
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(2));
  });

  it('leaves the microphone alone on an ordinary launch', async () => {
    registerVoicePipeline(pipeline);

    await render(<Harness />);
    await act(async () => {});

    expect(listen).not.toHaveBeenCalled();
    expect(screen.getByText('home')).toBeTruthy();
  });

  /**
   * The flag is read locally and must be cleared locally.
   *
   * `router.setParams` is expo-router's *global* setter: it writes to whichever
   * route is focused, which need not be the one whose params were read. Any
   * moment where home is mounted but not focused — a cold launch from the tile
   * while the pipeline is still a bootstrap step, with a cached push tap
   * putting /tasks on top — sent the clear to the wrong screen. Home then kept
   * `speak='1'` for ever: `requested` never went false, the re-arm below it was
   * unreachable, and every later widget mic, Quick Settings tile and Control
   * Center tap resolved to identical params and silently did nothing.
   */
  it('clears the flag on its own route, never through the global setter', async () => {
    registerVoicePipeline(pipeline);
    mockParams = { speak: '1' };

    await render(<Harness />);

    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    expect(mockSetParams).toHaveBeenCalledWith({ [SPEAK_PARAM]: '' });
    expect(mockGlobalSetParams).not.toHaveBeenCalled();
  });

  /**
   * And the microphone opens first. `setParams` asserts the navigator is ready
   * and throws when it is not — and the guard was already consumed by then, so
   * a throw ate the intent and never opened anything.
   */
  it('still opens the microphone when the flag cannot be cleared', async () => {
    registerVoicePipeline(pipeline);
    mockSetParams.mockImplementation(() => {
      throw new Error('Attempted to navigate before mounting the Root Layout component.');
    });
    mockParams = { speak: '1' };

    await render(<Harness />);

    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
  });

  it('addresses home with the flag, not a route of its own', () => {
    expect(speakHref()).toEqual({ pathname: '/', params: { speak: '1' } });
  });
});

/**
 * The URL exists four times and must be one thing.
 *
 * There is no shared source these could import — an Xcode extension links
 * neither the app nor React Native, and an Android widget is XML replayed by the
 * launcher's process. So the agreement is asserted by reading the shipped files
 * as text, the same way `widget-tokens.test.ts` holds the heat ramp together.
 */
describe('the deep link, across four files', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..');
  const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

  it('is home with the flag on it', () => {
    expect(SPEAK_DEEP_LINK).toBe('ridik:///?speak=1');
  });

  it('is the same string in the iOS widget', () => {
    const swift = read('targets/RidikWidget/RidikElements.swift');
    expect(swift).toContain(`static let speak = url("${SPEAK_DEEP_LINK}")`);
  });

  it('is the same string in the Android widget', () => {
    const kotlin = read(
      'modules/ridik-widgets/android/src/main/java/ai/raisen/ridik/widgets/RidikCells.kt',
    );
    expect(kotlin).toContain(`const val SPEAK_TARGET = "${SPEAK_DEEP_LINK}"`);
  });

  /* The launcher long-press. iOS takes its actions from the config plugin at
     build time, so this one is compiled in rather than registered. */
  it('is the same address in the iOS quick action', () => {
    const config = read('app.config.ts');
    expect(config).toContain(`href: '/?${SPEAK_PARAM}=1'`);
  });

  /**
   * And a fifth place, which refuses it rather than opening it.
   *
   * A push may open home, so the parameter is what push routing has to bar —
   * it cannot bar the segment. `briefingPush.ts` is pure by contract and this
   * module is a hook over expo-router, so the name is spelled twice; if the
   * flag were ever renamed and only one copy followed, a notification would
   * silently regain the ability to switch somebody's microphone on.
   */
  it('is the parameter a push is not allowed to carry', () => {
    expect(PUSH_BLOCKED_PARAMS).toContain(SPEAK_PARAM);
    expect(resolvePushHref({ data: { href: SPEAK_DEEP_LINK } }, null)).toBeNull();
  });
});

/**
 * The mic itself, which has to appear on the same faces on both platforms or the
 * two stop being one product.
 *
 * Medium and large only, and for a reason neither platform states out loud: a
 * `.systemSmall` widget has exactly one tap target, so a mic drawn on a small
 * tile would open the reading screen on iOS and the microphone on Android.
 */
describe('the affordance, on the same faces on both platforms', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..');

  /**
   * Generated once for the whole file. `resourceFiles()` writes 136 files and
   * about two megabytes of XML — calling it per assertion put a second on each
   * one and timed out an unrelated suite sharing the same worker.
   */
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ANDROID: Record<string, string> = require('../../../../plugins/withRidikAndroidWidget').resourceFiles();

  it('is drawn on iOS everywhere except small', () => {
    const swift = readFileSync(
      join(ROOT, 'targets/RidikWidget/RidikElements.swift'),
      'utf8',
    );
    expect(swift).toContain('struct SpeakAffordance');
    expect(swift).toContain('if family != .systemSmall');
    // In the shared header, so every face carries it and none of them decides.
    expect(swift).toContain('SpeakAffordance(palette: palette)');
  });

  it('is generated into every Android layout except the small ones', () => {
    const layouts = Object.keys(ANDROID).filter((name) => name.startsWith('layout/'));
    expect(layouts.length).toBeGreaterThan(0);

    const withMic = layouts.filter((name) => ANDROID[name]!.includes('@+id/ridik_mic'));
    const small = layouts.filter((name) => name.includes('_small'));

    expect(small.every((name) => !withMic.includes(name))).toBe(true);
    expect(withMic.length).toBe(layouts.length - small.length);
  });

  it('ships the glyph and its accessible name', () => {
    expect(ANDROID['drawable/ridik_widget_mic.xml']).toContain('<vector');
    expect(ANDROID['values/ridik_widget_speak.xml']).toContain('ridik_widget_speak_label');
  });

  /* The colour is a reference resolved by the launcher, never an int computed
     here — the bug that once wrote every row title near-black onto a near-black
     tile. A tint is the same trap with the same answer. */
  it('tints the glyph by reference, per ember', () => {
    expect(ANDROID['layout/ridik_today_medium_kiln.xml']).toContain(
      'android:tint="@color/ridik_widget_kiln_accent"',
    );
  });
});

/**
 * The system-level button: Control Center / Lock Screen on iOS, Quick Settings
 * on Android.
 *
 * **Both platforms or neither.** A quick-capture button that exists on one and
 * not the other is the "two different products" failure AGENTS.md is about,
 * arriving through the door nobody would spot in a screenshot comparison —
 * which is exactly why it is asserted as a pair rather than one file at a time.
 */
describe('the system control, on both platforms', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..');
  const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

  it('is a control widget in the existing iOS extension, opening the same URL', () => {
    const control = read('targets/RidikWidget/RidikControls.swift');
    expect(control).toContain('struct RidikSpeakControl: ControlWidget');
    expect(control).toContain('OpenURLIntent(Route.speak)');
    // iOS 18, in an extension that ships to 16.4 — so it has to be guarded
    // rather than raise the whole target's floor.
    expect(control).toContain('@available(iOS 18.0, *)');
  });

  /* A control the bundle never lists does not exist, and nothing about that
     fails: the extension builds, the five widgets ship, and the button is
     simply not in Control Center's gallery. */
  it('is listed in the widget bundle, under an availability guard', () => {
    const bundle = read('targets/RidikWidget/RidikWidgetBundle.swift');
    expect(bundle).toContain('if #available(iOS 18.0, *)');
    expect(bundle).toContain('RidikSpeakControl()');
  });

  it('is a tile service on Android, opening the same URL', () => {
    const tile = read(
      'modules/ridik-widgets/android/src/main/java/ai/raisen/ridik/widgets/RidikSpeakTileService.kt',
    );
    expect(tile).toContain('class RidikSpeakTileService : TileService()');
    expect(tile).toContain('Uri.parse(SPEAK_TARGET)');
    // `startActivityAndCollapse(Intent)` throws once the app targets 34, and the
    // `PendingIntent` overload does not exist below it. Both branches ship.
    expect(tile).toContain('Build.VERSION_CODES.UPSIDE_DOWN_CAKE');
    expect(tile).toContain('unlockAndRun');
  });

  /**
   * And it has to reach the manifest. Without `BIND_QUICK_SETTINGS_TILE` the
   * system will not bind the service at all, and the failure is that the tile
   * never appears in the edit list with nothing logged anywhere.
   */
  it('registers the tile in the manifest, with the permission that binds it', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { addSpeakTile } = require('../../../../plugins/withRidikAndroidWidget');
    const application: Record<string, unknown> = {};
    addSpeakTile(application);

    const services = application['service'] as { $: Record<string, string> }[];
    expect(services).toHaveLength(1);
    expect(services[0]!.$['android:name']).toBe(
      'ai.raisen.ridik.widgets.RidikSpeakTileService',
    );
    expect(services[0]!.$['android:permission']).toBe(
      'android.permission.BIND_QUICK_SETTINGS_TILE',
    );
    expect(services[0]!.$['android:exported']).toBe('true');
  });

  /* `android/` survives a prebuild, so an entry that is appended rather than
     replaced becomes two services for one class — which is a manifest merger
     failure, not a duplicate tile. */
  it('replaces its own entry on a second prebuild rather than adding a second', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { addSpeakTile } = require('../../../../plugins/withRidikAndroidWidget');
    const application: Record<string, unknown> = {};
    addSpeakTile(application);
    addSpeakTile(application);
    expect((application['service'] as unknown[]).length).toBe(1);
  });
});
