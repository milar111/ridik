import { freezeClock } from '@/core/clock';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createHabitsRepository } from '@/repositories/habits';
import { applyImport, buildBackup } from '../json';

const AT = Date.UTC(2026, 7, 11, 9, 0, 0);

let source: TestDatabase;
let restore: () => void;

beforeEach(() => {
  source = createTestDatabase();
  restore = freezeClock(AT);
});
afterEach(() => {
  restore();
  source.close();
});

function seedSource() {
  source.client.runSync(
    `INSERT INTO habits (id, name, longest_streak, current_streak, last_completed_date, unit, is_archived, created_at)
     VALUES ('h-old', 'running', 9, 9, '2026-08-11', 'session', 0, ?)`,
    [AT],
  );
  for (let i = 0; i < 3; i++) {
    source.client.runSync(
      `INSERT INTO activity_feed (id, habit_id, description, logged_at, local_date, source)
       VALUES (?, 'h-old', 'run', ?, ?, 'habit')`,
      [`a-${i}`, AT, `2026-08-0${i + 9}`],
    );
  }
  return buildBackup(source.client);
}

it('DOWNSTREAM: is the restored habit reachable, and does it keep its history?', async () => {
  const backup = seedSource();
  const target = createTestDatabase();
  try {
    target.client.runSync(
      `INSERT INTO habits (id, name, longest_streak, current_streak, unit, is_archived, created_at)
       VALUES ('h-here', 'Running', 0, 0, 'session', 0, ?)`,
      [AT],
    );
    const result = applyImport(target.client, backup);
    console.log('SUMMARY', JSON.stringify(result));

    const repo = createHabitsRepository(target.db);

    // What the /habits screen actually renders.
    const listed = await repo.listHabits();
    console.log(
      'LIST (what the screen maps over):',
      JSON.stringify(listed.map((h) => ({ id: h.id, name: h.name, streak: h.currentStreak }))),
    );

    // The card calls useHabitHistory(habit.id) — per id, not per name.
    for (const h of listed) {
      console.log(`HISTORY of ${h.id} (${h.name}):`, JSON.stringify(await repo.habitHistory(h.id)));
    }

    // The card's archive path is by id.
    console.log('archiveHabit("h-old") ->', JSON.stringify(await repo.archiveHabit('h-old', true)));
    console.log(
      'LIST after archive:',
      JSON.stringify((await repo.listHabits()).map((h) => h.name)),
    );
  } finally {
    target.close();
  }
});

it('COUNTERFACTUAL: what the proposed NOCASE constraint would do to the same restore', async () => {
  const backup = seedSource();
  const target = createTestDatabase();
  try {
    // The fix the report asks for.
    target.client.execSync(
      'CREATE UNIQUE INDEX idx_habits_name ON habits(name COLLATE NOCASE)',
    );
    target.client.runSync(
      `INSERT INTO habits (id, name, longest_streak, current_streak, unit, is_archived, created_at)
       VALUES ('h-here', 'Running', 0, 0, 'session', 0, ?)`,
      [AT],
    );
    const result = applyImport(target.client, backup);
    console.log('FIXED SUMMARY', JSON.stringify(result));
    console.log(
      'FIXED HABITS',
      JSON.stringify(target.client.getAllSync('SELECT id, name, current_streak FROM habits', [])),
    );
    console.log(
      'FIXED activity_feed',
      JSON.stringify(target.client.getAllSync('SELECT id, habit_id, local_date FROM activity_feed', [])),
    );
  } finally {
    target.close();
  }
});

it('MIGRATION RISK: can a NOCASE unique index be added to a table that already holds both?', () => {
  const target = createTestDatabase();
  try {
    target.client.runSync(
      `INSERT INTO habits (id, name, unit, is_archived, created_at) VALUES ('a', 'Running', 'session', 0, ?)`,
      [AT],
    );
    target.client.runSync(
      `INSERT INTO habits (id, name, unit, is_archived, created_at) VALUES ('b', 'running', 'session', 0, ?)`,
      [AT],
    );
    try {
      target.client.execSync('CREATE UNIQUE INDEX idx_habits_name ON habits(name COLLATE NOCASE)');
      console.log('MIGRATION: index created fine');
    } catch (error) {
      console.log('MIGRATION FAILED:', (error as Error).message);
    }
  } finally {
    target.close();
  }
});
