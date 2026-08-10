import { render, screen, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ThemeProvider } from '../ThemeProvider';
import PeopleScreen from '../../../app/people';

// The component barrel reaches Toast, which reaches reanimated — and reanimated's
// own mock still loads the native worklets module, so the entry animations Toast
// asks for are stubbed by hand instead.
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native');
  const builder: { duration: () => unknown } = { duration: () => builder };
  return {
    __esModule: true,
    default: { View },
    FadeInUp: builder,
    FadeOutUp: builder,
    LinearTransition: builder,
  };
});

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
}));

jest.mock('@/hooks', () => ({
  useCrmEntities: jest.fn(),
  useOpenCommitments: jest.fn(),
}));

const hooks = jest.requireMock('@/hooks') as {
  useCrmEntities: jest.Mock;
  useOpenCommitments: jest.Mock;
};

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function entity(name: string, over: Partial<{ id: string; context: string | null }> = {}) {
  const id = over.id ?? name.toLowerCase();
  return {
    entity: {
      id,
      name,
      relationshipContext: over.context ?? null,
      aliases: null,
      createdAt: 0,
      updatedAt: 0,
    },
    aliases: [] as string[],
    openCommitments: 0,
    interactionCount: 0,
    lastInteractionAt: null as number | null,
  };
}

function wrap(ui: React.ReactElement) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider forceScheme="dark">{ui}</ThemeProvider>
    </SafeAreaProvider>,
  );
}

function setData(entities: unknown[], commitments: unknown[] = []) {
  hooks.useCrmEntities.mockReturnValue({ data: entities, isPending: false, isError: false });
  hooks.useOpenCommitments.mockReturnValue({ data: commitments, isPending: false, isError: false });
}

describe('people screen', () => {
  it('teaches the user what to say when nobody is recorded', async () => {
    setData([]);
    await wrap(<PeopleScreen />);
    expect(screen.getByText(/met with Ivo/)).toBeTruthy();
  });

  it('lists people with their open-commitment count', async () => {
    const ivo = entity('Ivo Petrov', { context: 'CNC shop' });
    ivo.openCommitments = 2;
    setData([ivo, entity('Maria')]);

    await wrap(<PeopleScreen />);
    expect(screen.getByText('Ivo Petrov')).toBeTruthy();
    expect(screen.getByText('CNC shop')).toBeTruthy();
    expect(screen.getByText('2 open')).toBeTruthy();
    expect(screen.getByText('IP')).toBeTruthy();
  });

  it('filters on aliases, not just on the display name', async () => {
    const ivan = entity('Ivan');
    ivan.aliases = ['Vanya'];
    setData([ivan, entity('Maria')]);

    await wrap(<PeopleScreen />);
    await fireEvent.changeText(screen.getByLabelText('Search people'), 'vanya');
    expect(screen.getByText('Ivan')).toBeTruthy();
    expect(screen.queryByText('Maria')).toBeNull();
  });
});
