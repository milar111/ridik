/**
 * Notification taps and buttons, which did nothing whatsoever.
 *
 * `subscribeToResponses()` and `getLaunchResponse()` were exported and called
 * from nowhere. The ongoing focus notification's Pause / Resume / Skip / Stop
 * buttons were inert, and `handleTimerAction()` — written for exactly them, and
 * whose own docblock claimed the root layout forwarded to it — was unreachable.
 * Every scheduled reminder carried an `href` that tapping never opened.
 *
 * The listener is now a bootstrap step. These tests drive the handler it
 * installs, because that is the part that can be exercised under Node: whether
 * the OS actually delivers the event is a device question and is not claimed
 * here.
 */
const mockSubscribe = jest.fn();
const mockLaunchResponse = jest.fn();
const mockTimerAction = jest.fn();
const mockNavigate = jest.fn();

jest.mock('../local', () => ({
  subscribeToResponses: (...args: unknown[]) => mockSubscribe(...args),
  getLaunchResponse: () => mockLaunchResponse(),
}));

jest.mock('expo-router', () => ({ router: { navigate: (...a: unknown[]) => mockNavigate(...a) } }));

jest.mock('@/services/focus', () => ({
  handleTimerAction: (...args: unknown[]) => mockTimerAction(...args),
}));

jest.mock('@/startup/bootstrap', () => ({ registerBootstrapStep: () => {} }));

const TAPPED = 'expo.modules.notifications.actions.DEFAULT';

/** The handler the module hands to `subscribeToResponses`. */
type Response = { actionIdentifier: string; data: Record<string, unknown> };
let deliver: (response: Response) => void;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockTimerAction.mockResolvedValue({ ok: true, value: null });
  mockLaunchResponse.mockResolvedValue(null);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../responses') as { installNotificationResponses: () => void };
  mod.installNotificationResponses();
  deliver = mockSubscribe.mock.calls[0]![0] as (r: Response) => void;
});

afterEach(() => {
  jest.useRealTimers();
});

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  jest.runAllTimers();
  await Promise.resolve();
}

describe('the timer buttons', () => {
  it.each(['pause', 'resume', 'skip', 'stop'])('runs %s', async (action) => {
    deliver({ actionIdentifier: action, data: { entityId: 'session-1' } });
    await settle();

    expect(mockTimerAction).toHaveBeenCalledWith(action, { entityId: 'session-1' });
    // A button is not a route. Pressing Pause must not also navigate.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  /* The session id is forwarded because `handleTimerAction` uses it to ignore a
     button pressed on a notification left over from an earlier session. */
  it('forwards the session it came from', async () => {
    deliver({ actionIdentifier: 'stop', data: { entityId: 'old-session' } });
    await settle();

    expect(mockTimerAction).toHaveBeenCalledWith('stop', { entityId: 'old-session' });
  });
});

describe('tapping the body', () => {
  it('opens the route the notification carried', async () => {
    deliver({ actionIdentifier: TAPPED, data: { href: '/tasks' } });
    await settle();

    expect(mockNavigate).toHaveBeenCalledWith('/tasks');
  });

  it('does nothing when there is no route', async () => {
    deliver({ actionIdentifier: TAPPED, data: {} });
    await settle();

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  /**
   * `ridik:///?speak=1` is the one address in this app that is a verb.
   *
   * A notification that could carry a query string would be a way to start a
   * recording from outside the app — the same hole `PUSH_BLOCKED_PARAMS`
   * closes on the push side. The route survives; the parameter does not.
   */
  it('strips a query string rather than opening it', async () => {
    deliver({ actionIdentifier: TAPPED, data: { href: '/?speak=1' } });
    await settle();

    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('refuses anything that is not an in-app route', async () => {
    for (const href of ['https://example.com', 'ridik:///tasks', '', 42]) {
      mockNavigate.mockClear();
      deliver({ actionIdentifier: TAPPED, data: { href } });
      await settle();
      expect(mockNavigate).not.toHaveBeenCalled();
    }
  });

  /* An id this build does not know is not a tap. Treating every unknown action
     as one would route a future button to a screen instead of running it. */
  it('ignores an action it does not recognise', async () => {
    deliver({ actionIdentifier: 'snooze', data: { href: '/tasks' } });
    await settle();

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockTimerAction).not.toHaveBeenCalled();
  });
});

describe('installing it twice', () => {
  /* Fast refresh re-runs the bootstrap. Two listeners means every tap is
     handled twice — which for a timer button is a pause followed by a resume. */
  it('replaces the previous listener rather than adding one', () => {
    const unsubscribe = jest.fn();
    mockSubscribe.mockReturnValue(unsubscribe);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../responses') as { installNotificationResponses: () => void };
    mod.installNotificationResponses();
    mod.installNotificationResponses();

    expect(unsubscribe).toHaveBeenCalled();
  });
});
