import { freezeClock, resetClock } from '@/core/clock';
import { projectItems } from '@/db/schema';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createProjectsRepository } from '@/repositories/projects';

const BASE = Date.UTC(2026, 7, 11, 9, 0, 0);

describe('concurrency probe', () => {
  let t: TestDatabase;

  beforeEach(() => {
    freezeClock(BASE);
    t = createTestDatabase();
  });
  afterEach(() => {
    resetClock();
    t.close();
  });

  it('two toggleItem calls started together', async () => {
    const repo = createProjectsRepository(t.db);
    const p = await repo.createProject({ name: 'Trip' });
    const items = await repo.addItems(p.id, [
      { content: 'one', isCheckbox: true },
      { content: 'two', isCheckbox: true },
    ]);

    const results = await Promise.allSettled([
      repo.toggleItem(items[0].id, true),
      repo.toggleItem(items[1].id, true),
    ]);
    // eslint-disable-next-line no-console
    console.log('RESULTS', results.map((r) => r.status === 'rejected' ? String(r.reason) : 'ok'));

    const rows = await t.db.select().from(projectItems);
    // eslint-disable-next-line no-console
    console.log('COMPLETED', rows.map((r) => [r.content, r.isCompleted]));
  });
});
