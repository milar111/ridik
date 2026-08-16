/**
 * How a local notification is *delivered*, which is the half nothing checked.
 *
 * The content is easy to see and easy to test; the delivery is neither, and it
 * is where both of these bugs lived. `app.config.ts` has declared the
 * time-sensitive entitlement since the first build, and the only place that
 * ever set `interruptionLevel` was the focus service — so a task reminder and
 * an arriving place reminder, the two notifications whose entire value is the
 * moment they arrive, were delivered at ordinary priority and swallowed by the
 * Focus mode somebody turns on precisely because they are busy. And on Android
 * the immediate path passed no channel at all, so a geofence crossing landed on
 * "General" while the user looked at a "Place reminders" channel that governed
 * nothing they ever received.
 *
 * Both are invisible on a device until the day they matter, which is what makes
 * them worth a test rather than a look.
 */
const mockPlatform = { OS: 'ios' as 'ios' | 'android' };

jest.mock('react-native', () => ({
  get Platform() {
    return mockPlatform;
  },
}));

type Request = {
  content: { interruptionLevel?: string };
  trigger: { channelId?: string } | null;
};

// `mock`-prefixed, or the factory below may not reach them: jest hoists it
// above every declaration in the file and refuses out-of-scope names.
const mockSchedule = jest.fn(async (_request: Request) => 'notification-id');

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => ({})),
  setNotificationCategoryAsync: jest.fn(async () => ({})),
  scheduleNotificationAsync: (request: unknown) => mockSchedule(request as Request),
  getPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true, ios: {} })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  AndroidImportance: { DEFAULT: 3, HIGH: 4, LOW: 2 },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
}));

import { now } from '@/core/clock';
import { CHANNELS, presentNow, scheduleAt } from '../local';

const lastSent = (): Request => mockSchedule.mock.calls.at(-1)![0];

/** Far enough ahead to take the scheduled path rather than the immediate one. */
const LATER = () => now() + 60_000;

beforeEach(() => {
  mockSchedule.mockClear();
  mockPlatform.OS = 'ios';
});

describe('what may interrupt a Focus mode', () => {
  it('a reminder, which is the whole point of one', async () => {
    await scheduleAt({ title: 'Call Ivo', at: LATER(), channel: CHANNELS.reminders });
    expect(lastSent().content.interruptionLevel).toBe('timeSensitive');
  });

  /* The default is the reminders channel, so a caller that names nothing is
     naming a reminder. */
  it('a reminder scheduled without naming its channel', async () => {
    await scheduleAt({ title: 'Call Ivo', at: LATER() });
    expect(lastSent().content.interruptionLevel).toBe('timeSensitive');
  });

  it('arriving somewhere, which is a moment and not a message', async () => {
    await presentNow({ title: 'You are at the hardware shop', channel: CHANNELS.places });
    expect(lastSent().content.interruptionLevel).toBe('timeSensitive');
  });

  /**
   * And the two that must not. A running timer re-posts on every phase change
   * on a silent LOW channel — marking it would make a background clock the
   * loudest thing the app sends. The one moment it does have to interrupt, the
   * lock-screen fallback in `services/focus/liveActivity.ts`, sets the level on
   * that notification itself.
   */
  it('not a timer', async () => {
    await scheduleAt({ title: 'Break over', at: LATER(), channel: CHANNELS.timers });
    expect(lastSent().content.interruptionLevel).toBeUndefined();
  });

  it('not the morning briefing', async () => {
    await scheduleAt({ title: 'Your day', at: LATER(), channel: CHANNELS.briefing });
    expect(lastSent().content.interruptionLevel).toBeUndefined();
  });
});

describe('which Android channel it lands on', () => {
  beforeEach(() => {
    mockPlatform.OS = 'android';
  });

  it('the one asked for, when it is scheduled', async () => {
    await scheduleAt({ title: 'Call Ivo', at: LATER(), channel: CHANNELS.reminders });
    expect(lastSent().trigger).toMatchObject({ channelId: CHANNELS.reminders });
  });

  /* A `null` trigger is immediate *and* channelless, which is how every
     geofence crossing — all of which go through `presentNow` — was delivered
     on the default channel at DEFAULT importance. */
  it('the one asked for, when it is immediate', async () => {
    await presentNow({ title: 'You are at the hardware shop', channel: CHANNELS.places });
    expect(lastSent().trigger).toEqual({ channelId: CHANNELS.places });
  });

  it('and iOS still gets no trigger for an immediate one', async () => {
    mockPlatform.OS = 'ios';
    await presentNow({ title: 'You are at the hardware shop', channel: CHANNELS.places });
    expect(lastSent().trigger).toBeNull();
  });
});
