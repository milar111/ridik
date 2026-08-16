import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { freezeClock, resetClock } from '@/core/clock';
import { projectItems } from '@/db/schema';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createProjectsRepository, type ProjectsRepository } from '@/repositories/projects';
import { cancelKeys, invalidateKeys, qk, restoreQueries, snapshotQueries } from '@/hooks/keys';

const BASE = Date.UTC(2026, 7, 11, 9, 0, 0);
const PROJECT_WRITE_KEYS = [qk.projects.all] as const;

describe('window width probe', () => {
  let t: TestDatabase;
  let repo: ProjectsRepository;

  beforeEach(() => {
    freezeClock(BASE);
    t = createTestDatabase();
    repo = createProjectsRepository(t.db);
  });
  afterEach(() => {
    resetClock();
    t.close();
  });

  function makeObserver(client: QueryClient, errors: string[]) {
    return new MutationObserver<unknown, Error, { itemId: string; completed: boolean }, { previous: ReturnType<typeof snapshotQueries> }>(
      client,
      {
        mutationFn: (input) => repo.toggleItem(input.itemId, input.completed),
        onMutate: async () => {
          await cancelKeys(client, PROJECT_WRITE_KEYS);
          const previous = snapshotQueries(client, PROJECT_WRITE_KEYS);
          return { previous };
        },
        onError: (error, _v, ctx) => {
          errors.push(error.message);
          restoreQueries(client, ctx?.previous);
        },
        onSettled: () => invalidateKeys(client, PROJECT_WRITE_KEYS),
        retry: 0,
      },
    );
  }

  it('real refetch in flight (synchronous repository read), taps one macrotask apart', async () => {
    const p = await repo.createProject({ name: 'Trip' });
    const items = await repo.addItems(p.id, [
      { content: 'one', isCheckbox: true },
      { content: 'two', isCheckbox: true },
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const errors: string[] = [];

    // Exactly what useProjectOverview does: a pure SQLite read, no real I/O.
    void client
      .fetchQuery({
        queryKey: [...qk.projects.all, 'overview', p.id],
        queryFn: () => repo.getProjectOverview(p.id),
      })
      .catch(() => undefined);

    const a = makeObserver(client, errors).mutate({ itemId: items[0]!.id, completed: true });
    await new Promise((r) => setTimeout(r, 0));
    const b = makeObserver(client, errors).mutate({ itemId: items[1]!.id, completed: true });
    const settled = await Promise.allSettled([a, b]);
    // eslint-disable-next-line no-console
    console.log('inflight+apart', settled.map((s) => (s.status === 'fulfilled' ? 'ok' : String((s as PromiseRejectedResult).reason))), 'errors=', errors);
    // eslint-disable-next-line no-console
    console.log('rows', (await t.db.select().from(projectItems)).map((r) => [r.content, r.isCompleted]));
  });

  it('after a collision the next tap succeeds and the DB is consistent', async () => {
    const p = await repo.createProject({ name: 'Trip' });
    const items = await repo.addItems(p.id, [
      { content: 'one', isCheckbox: true },
      { content: 'two', isCheckbox: true },
    ]);
    // Force the collision.
    const settled = await Promise.allSettled([
      repo.toggleItem(items[0]!.id, true),
      repo.toggleItem(items[1]!.id, true),
    ]);
    // eslint-disable-next-line no-console
    console.log('forced', settled.map((s) => s.status));
    // The retry, as the user's second tap would do it.
    await repo.toggleItem(items[1]!.id, true);
    // eslint-disable-next-line no-console
    console.log('after retry', (await t.db.select().from(projectItems)).map((r) => [r.content, r.isCompleted]));
    // And the connection is not left inside a transaction.
    t.db.$client.execSync('BEGIN');
    t.db.$client.execSync('COMMIT');
    // eslint-disable-next-line no-console
    console.log('connection clean: yes');
  });
});
