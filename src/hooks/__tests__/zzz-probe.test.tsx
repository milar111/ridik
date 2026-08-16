import { renderHook, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

import { freezeClock, resetClock } from '@/core/clock';
import { projectItems } from '@/db/schema';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createRepositories, type Repositories } from '@/repositories';

const mockHolder: { repos: Repositories | null } = { repos: null };
jest.mock('@/repositories', () => {
  const actual = jest.requireActual('@/repositories');
  return { ...actual, getRepositories: () => mockHolder.repos };
});

import { useToggleProjectItem, useProjectOverview } from '../useProjects';

const BASE = Date.UTC(2026, 7, 11, 9, 0, 0);
let t: TestDatabase;
let client: QueryClient;

beforeEach(() => {
  freezeClock(BASE);
  t = createTestDatabase();
  mockHolder.repos = createRepositories(t.db);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  resetClock();
  client.clear();
  t.close();
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

const macrotask = () => new Promise((r) => setTimeout(r, 0));

describe('two checkbox taps', () => {
  it('separate macrotasks (a real double tap)', async () => {
    const p = await mockHolder.repos!.projects.createProject({ name: 'Trip' });
    const items = await mockHolder.repos!.projects.addItems(p.id, [
      { content: 'one', isCheckbox: true },
      { content: 'two', isCheckbox: true },
    ]);

    const errors: string[] = [];
    const { result } = await renderHook(
      () => {
        useProjectOverview(p.id);
        return useToggleProjectItem();
      },
      { wrapper },
    );

    await act(async () => {
      // tap 1 — its own JS task
      result.current.mutate(
        { itemId: items[0].id, completed: true },
        { onError: (e) => errors.push(String(e)) },
      );
      await macrotask();
      // tap 2 — the very next JS task
      result.current.mutate(
        { itemId: items[1].id, completed: true },
        { onError: (e) => errors.push(String(e)) },
      );
      await macrotask();
      await macrotask();
    });

    const rows = await t.db.select().from(projectItems);
    // eslint-disable-next-line no-console
    console.log('SEPARATE-TASKS errors=', errors, 'rows=', rows.map((r) => [r.content, r.isCompleted]));
  });

  it('same macrotask (both mutate() in one JS task)', async () => {
    const p = await mockHolder.repos!.projects.createProject({ name: 'Trip' });
    const items = await mockHolder.repos!.projects.addItems(p.id, [
      { content: 'one', isCheckbox: true },
      { content: 'two', isCheckbox: true },
    ]);

    const errors: string[] = [];
    const { result } = await renderHook(
      () => {
        useProjectOverview(p.id);
        return useToggleProjectItem();
      },
      { wrapper },
    );

    await act(async () => {
      result.current.mutate(
        { itemId: items[0].id, completed: true },
        { onError: (e) => errors.push(String(e)) },
      );
      result.current.mutate(
        { itemId: items[1].id, completed: true },
        { onError: (e) => errors.push(String(e)) },
      );
      await macrotask();
      await macrotask();
    });

    const rows = await t.db.select().from(projectItems);
    // eslint-disable-next-line no-console
    console.log('SAME-TASK errors=', errors, 'rows=', rows.map((r) => [r.content, r.isCompleted]));
  });
});

describe('adversarial: taps while a refetch is in flight', () => {
  it('slow overview refetch, two taps in separate macrotasks', async () => {
    const p = await mockHolder.repos!.projects.createProject({ name: 'Trip' });
    const items = await mockHolder.repos!.projects.addItems(p.id, [
      { content: 'one', isCheckbox: true },
      { content: 'two', isCheckbox: true },
    ]);

    // Make the overview read genuinely slow, so a refetch is really in flight
    // when the taps land and `cancelKeys` has something to wait on.
    const real = mockHolder.repos!.projects.getProjectOverview.bind(mockHolder.repos!.projects);
    let slow = false;
    // @ts-expect-error test override
    mockHolder.repos!.projects.getProjectOverview = async (id: string) => {
      if (slow) await new Promise((r) => setTimeout(r, 40));
      return real(id);
    };

    const errors: string[] = [];
    const { result } = await renderHook(
      () => {
        useProjectOverview(p.id);
        return useToggleProjectItem();
      },
      { wrapper },
    );
    await act(async () => { await macrotask(); });

    slow = true;
    await act(async () => {
      // kick off a refetch that will still be running when the taps land
      void client.invalidateQueries({ queryKey: ['ridik', 'projects'] });
      await Promise.resolve();
      result.current.mutate(
        { itemId: items[0].id, completed: true },
        { onError: (e) => errors.push(String(e)) },
      );
      await macrotask();
      result.current.mutate(
        { itemId: items[1].id, completed: true },
        { onError: (e) => errors.push(String(e)) },
      );
      await new Promise((r) => setTimeout(r, 120));
    });

    const rows = await t.db.select().from(projectItems);
    // eslint-disable-next-line no-console
    console.log('IN-FLIGHT errors=', errors, 'rows=', rows.map((r) => [r.content, r.isCompleted]));
  });
});
