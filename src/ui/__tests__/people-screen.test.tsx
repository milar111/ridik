import { render, screen, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ThemeProvider } from '../ThemeProvider';
import PeopleScreen from '../../../app/people';
// The list and the person behind it are one flow: the list is where a
// mis-heard contact is spotted, their own page is where it is deleted.
import PersonDetailScreen from '../../../app/person/[id]';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => ({ id: 'p1' }),
}));

jest.mock('@/hooks', () => ({
  useCrmEntities: jest.fn(),
  useOpenCommitments: jest.fn(),
  useCrmProfile: jest.fn(),
  useTask: jest.fn(),
  useAddCommitment: jest.fn(),
  useAddEntityAlias: jest.fn(),
  useCompleteCommitment: jest.fn(),
  useDeleteEntity: jest.fn(),
  useLogInteraction: jest.fn(),
  useRemoveCommitment: jest.fn(),
  useRemoveEntityAlias: jest.fn(),
  useRemoveInteraction: jest.fn(),
  useUpdateEntityContext: jest.fn(),
}));

const hooks = jest.requireMock('@/hooks') as Record<string, jest.Mock>;

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
  hooks.useCrmEntities!.mockReturnValue({ data: entities, isPending: false, isError: false });
  hooks.useOpenCommitments!.mockReturnValue({ data: commitments, isPending: false, isError: false });
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

/* -------------------------------------------------------------- person page */

const AT = Date.UTC(2026, 2, 12, 9, 0);

const COMMITMENT = {
  id: 'c1',
  entityId: 'p1',
  commitmentText: 'send the CAD files',
  dueDate: null,
  isCompleted: false,
  createdAt: AT,
  direction: 'i_owe' as const,
  taskId: null,
  completedAt: null,
};

const INTERACTION = {
  id: 'i1',
  entityId: 'p1',
  summary: 'talked about the plywood',
  occurredAt: AT,
  createdAt: AT,
};

const PROFILE = {
  entity: {
    id: 'p1',
    name: 'Ivo Petrov',
    relationshipContext: 'CNC shop',
    aliases: null,
    createdAt: AT,
    updatedAt: AT,
  },
  aliases: [] as string[],
  interactions: [INTERACTION],
  lastInteractionAt: AT,
  openCommitments: [COMMITMENT],
  completedCommitments: [] as (typeof COMMITMENT)[],
  transactions: [] as unknown[],
  spentByCurrency: {},
  receivedByCurrency: {},
  netByCurrency: {},
};

/** Every mutation the person page reaches for, so a press can be traced to one. */
function setProfile(): Record<string, jest.Mock> {
  const mutations: Record<string, jest.Mock> = {};
  for (const name of Object.keys(hooks)) {
    const mutate = jest.fn();
    mutations[name] = mutate;
    hooks[name]!.mockReturnValue({ mutate, isPending: false });
  }
  hooks.useCrmProfile!.mockReturnValue({ data: PROFILE, isPending: false, isError: false });
  hooks.useTask!.mockReturnValue({ data: null, isPending: false, isError: false });
  return mutations;
}

describe('person screen', () => {
  it('asks before deleting a person, and counts what goes with them', async () => {
    const mutations = setProfile();
    await wrap(<PersonDetailScreen />);

    await fireEvent.press(screen.getByLabelText('Delete person'));
    // The first tap only asks. Nothing is destroyed until the second one.
    expect(mutations.useDeleteEntity).not.toHaveBeenCalled();
    expect(screen.getByText('Delete Ivo Petrov?')).toBeTruthy();
    expect(screen.getByText(/1 interaction and 1 commitment go with them/)).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Delete'));
    expect(mutations.useDeleteEntity).toHaveBeenCalledWith(
      { entityId: 'p1', confirmed: true },
      expect.anything(),
    );
  });

  it('backs out of the person delete without touching anything', async () => {
    const mutations = setProfile();
    await wrap(<PersonDetailScreen />);

    await fireEvent.press(screen.getByLabelText('Delete person'));
    await fireEvent.press(screen.getByLabelText('Keep'));

    expect(screen.queryByText('Delete Ivo Petrov?')).toBeNull();
    expect(mutations.useDeleteEntity).not.toHaveBeenCalled();
  });

  it('asks before deleting a commitment or an interaction', async () => {
    const mutations = setProfile();
    await wrap(<PersonDetailScreen />);

    await fireEvent.press(screen.getByLabelText('Delete commitment: send the CAD files'));
    expect(mutations.useRemoveCommitment).not.toHaveBeenCalled();
    expect(screen.getByText('Delete this commitment?')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Delete'));
    expect(mutations.useRemoveCommitment).toHaveBeenCalledWith({ id: 'c1' }, expect.anything());

    await fireEvent.press(screen.getByLabelText('Delete interaction: talked about the plywood'));
    expect(mutations.useRemoveInteraction).not.toHaveBeenCalled();
    expect(screen.getByText('Delete this interaction?')).toBeTruthy();
  });
});
