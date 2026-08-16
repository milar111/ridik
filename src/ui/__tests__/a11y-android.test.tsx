/**
 * The half of the rule that only Android can break.
 *
 * On Android the words are spoken by `accessibilityLiveRegion` on the element
 * itself, so an announcement of the same sentence is a second voice saying it —
 * and `View.announceForAccessibility` is discouraged from API 34 anyway, which
 * is the other reason the region is the mechanism there. `useAnnounceOnIOS` is
 * the pair's iOS half and must be silent here; `useAnnounce` is for state no
 * element's text carries verbatim and still speaks.
 *
 * The rest of the suite runs as iOS (`jest-expo` reports `ios`), so this is the
 * only file that can see the other branch.
 */
jest.mock('react-native/Libraries/Utilities/Platform', () => {
  // The real one, with its answer changed: expo-modules-core reads this module
  // at setup and a hand-built stub loses the shape it expects.
  const actual = jest.requireActual('react-native/Libraries/Utilities/Platform');
  const real = (actual.default ?? actual) as Record<string, unknown>;
  const android = {
    ...real,
    OS: 'android',
    select: (spec: Record<string, unknown>) => ('android' in spec ? spec.android : spec.default),
  };
  return { __esModule: true, ...android, default: android };
});

import { AccessibilityInfo, Platform, Text } from 'react-native';
import { render } from '@testing-library/react-native';

import { useAnnounce, useAnnounceOnIOS } from '../a11y';

function OnIOS({ message }: { message: string }) {
  useAnnounceOnIOS(message);
  return <Text>{message}</Text>;
}

function Always({ message }: { message: string }) {
  useAnnounce(message);
  return <Text>{message}</Text>;
}

let announce: jest.SpyInstance;

beforeEach(() => {
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});

afterEach(() => {
  announce.mockRestore();
});

it('is running as Android (a guard that would otherwise pass vacuously)', () => {
  expect(Platform.OS).toBe('android');
});

it('leaves the live region to say it, rather than saying it twice', async () => {
  await render(<OnIOS message="Done. Task added" />);

  expect(announce).not.toHaveBeenCalled();
});

it('still speaks the state no element carries word for word', async () => {
  await render(<Always message="Listening. Tap to send." />);

  expect(announce).toHaveBeenCalledWith('Listening. Tap to send.');
});
