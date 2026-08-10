import { freezeClock } from '@/core/clock';
import type { AppError, Result } from '@/core/result';
import { newId } from '@/db/ids';
import { projects } from '@/db/schema';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import {
  createNotesRepository,
  escapeFtsQuery,
  type NotesRepository,
} from '@/repositories/notes';

const T0 = Date.UTC(2026, 1, 3, 8, 0, 0);

function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.userMessage}`);
  }
  return result.value;
}

function expectErr<T>(result: Result<T>): AppError {
  if (result.ok) throw new Error('expected an error, got a value');
  return result.error;
}

function countRows(t: TestDatabase, table: string): number {
  return t.client.getFirstSync<{ n: number }>(`SELECT count(*) AS n FROM ${table}`, [])?.n ?? 0;
}

describe('notes repository', () => {
  let t: TestDatabase;
  let repo: NotesRepository;
  let restoreClock: () => void;

  beforeEach(() => {
    restoreClock = freezeClock(T0);
    t = createTestDatabase();
    repo = createNotesRepository(t.db);
  });

  afterEach(() => {
    restoreClock();
    t.close();
  });

  const at = (offsetMs: number) => freezeClock(T0 + offsetMs);

  async function seedRobotics() {
    return repo.upsertNoteWithBullets({
      titleSummary: 'Robotics build log',
      categoryTag: 'hardware',
      bullets: ['Print the chassis', 'Order 2 servo horns'],
    });
  }

  /* --------------------------------------------------------------- creation */

  it('creates a note with ordered bullets', async () => {
    const note = await seedRobotics();
    expect(note.titleSummary).toBe('Robotics build log');
    expect(note.createdAt).toBe(T0);
    expect(note.bullets.map((b) => b.content)).toEqual(['Print the chassis', 'Order 2 servo horns']);
    expect(note.bullets.map((b) => b.orderIndex)).toEqual([0, 1]);
    expect(note.bullets.every((b) => b.bulletKind === 'text')).toBe(true);
  });

  it('creates todo bullets that can render as checkboxes', async () => {
    const note = await repo.upsertNoteWithBullets({
      titleSummary: 'Camping kit',
      categoryTag: 'trips',
      bullets: ['Tent', { content: 'Stove', isCompleted: true }],
      bulletKind: 'todo',
    });
    expect(note.bullets.map((b) => [b.bulletKind, b.isCompleted])).toEqual([
      ['todo', false],
      ['todo', true],
    ]);
  });

  it('appends instead of failing when (title, tag) already exists in another case', async () => {
    const first = await seedRobotics();
    at(60_000);
    const second = await repo.upsertNoteWithBullets({
      titleSummary: 'robotics BUILD log',
      categoryTag: 'HARDWARE',
      bullets: ['Use M3 screws'],
    });

    expect(second.id).toBe(first.id);
    expect(countRows(t, 'notes')).toBe(1);
    expect(second.bullets.map((b) => b.content)).toEqual([
      'Print the chassis',
      'Order 2 servo horns',
      'Use M3 screws',
    ]);
    expect(second.bullets.map((b) => b.orderIndex)).toEqual([0, 1, 2]);
    expect(second.updatedAt).toBe(T0 + 60_000);
  });

  it('links a note to a project and lists it by project', async () => {
    const projectId = newId();
    await t.db
      .insert(projects)
      .values({ id: projectId, name: 'Robot arm', createdAt: T0, updatedAt: T0 });

    await repo.upsertNoteWithBullets({
      titleSummary: 'Arm specs',
      categoryTag: 'hardware',
      bullets: ['Reach 40cm'],
      projectId,
    });
    await repo.upsertNoteWithBullets({
      titleSummary: 'Grocery list',
      categoryTag: 'home',
      bullets: ['Milk'],
    });

    expect((await repo.listNotes({ projectId })).map((n) => n.titleSummary)).toEqual(['Arm specs']);
    expect((await repo.listNotes({ projectId: null })).map((n) => n.titleSummary)).toEqual([
      'Grocery list',
    ]);
  });

  /* ------------------------------------------------------------- resolution */

  it('appends to the right note when the user names it loosely', async () => {
    await seedRobotics();
    await repo.upsertNoteWithBullets({
      titleSummary: 'Kitchen renovation',
      categoryTag: 'home',
      bullets: ['Tile grout colour'],
    });

    const resolved = expectOk(await repo.resolveNote('my Robotics note'));
    expect(resolved.titleSummary).toBe('Robotics build log');

    at(1_000);
    const updated = expectOk(await repo.appendBullets(resolved.id, ['Use M3 screws']));
    expect(updated.bullets.map((b) => b.content)).toEqual([
      'Print the chassis',
      'Order 2 servo horns',
      'Use M3 screws',
    ]);
    expect(countRows(t, 'notes')).toBe(2);
  });

  it('resolves through the tag and bullet text as secondary evidence', async () => {
    await seedRobotics();
    const resolved = expectOk(await repo.resolveNote('servo horns'));
    expect(resolved.titleSummary).toBe('Robotics build log');
  });

  it('refuses to guess between two plausible notes', async () => {
    await seedRobotics();
    await repo.upsertNoteWithBullets({
      titleSummary: 'Robotics parts list',
      categoryTag: 'hardware',
      bullets: ['Brushless motor'],
    });

    const error = expectErr(await repo.resolveNote('robotics'));
    expect(error.code).toBe('ambiguous');
    const details = error.details as { candidates: { titleSummary: string; score: number }[] };
    expect(details.candidates).toHaveLength(2);
    expect(details.candidates.map((c) => c.titleSummary).sort()).toEqual([
      'Robotics build log',
      'Robotics parts list',
    ]);
    expect(details.candidates.every((c) => c.score > 0)).toBe(true);
  });

  it('reports not_found rather than picking an unrelated note', async () => {
    await seedRobotics();
    const error = expectErr(await repo.resolveNote('tax return'));
    expect(error.code).toBe('not_found');
  });

  it('ignores archived notes when resolving unless asked', async () => {
    const note = await seedRobotics();
    await repo.softArchive(note.id);

    expect(expectErr(await repo.resolveNote('robotics')).code).toBe('not_found');
    expect(expectOk(await repo.resolveNote('robotics', { includeArchived: true })).id).toBe(note.id);
  });

  /* --------------------------------------------------------------- ordering */

  it('orders pinned first, then most recently touched — never by creation date', async () => {
    const kitchen = await repo.upsertNoteWithBullets({
      titleSummary: 'Kitchen renovation',
      categoryTag: 'home',
      bullets: ['Tile grout colour'],
    });
    at(1_000);
    const robotics = await seedRobotics();

    at(2_000);
    await repo.appendBullets(kitchen.id, ['Book the plumber']);
    // Newest note first would be creation order; recency of *use* wins instead.
    expect((await repo.listNotes()).map((n) => n.id)).toEqual([kitchen.id, robotics.id]);

    at(3_000);
    await repo.updateNote(robotics.id, { isPinned: true });
    at(4_000);
    await repo.appendBullets(kitchen.id, ['Pick a worktop']);

    const listed = await repo.listNotes();
    expect(listed.map((n) => n.id)).toEqual([robotics.id, kitchen.id]);
    // The pinned note is both older and less recently updated than the other.
    expect(listed[0]!.updatedAt).toBeLessThan(listed[1]!.updatedAt);
    expect(listed[0]!.createdAt).toBeGreaterThan(listed[1]!.createdAt);
  });

  it('hides archived notes from listings until asked', async () => {
    const note = await seedRobotics();
    await repo.upsertNoteWithBullets({
      titleSummary: 'Old ideas',
      categoryTag: 'misc',
      bullets: ['Something'],
    });
    const archived = expectOk(await repo.softArchive(note.id));
    expect(archived.isArchived).toBe(true);

    expect((await repo.listNotes()).map((n) => n.titleSummary)).toEqual(['Old ideas']);
    expect(await repo.listNotes({ includeArchived: true })).toHaveLength(2);

    expectOk(await repo.unarchiveNote(note.id));
    expect(await repo.listNotes()).toHaveLength(2);
  });

  it('filters by tag case-insensitively and counts tags', async () => {
    await seedRobotics();
    await repo.upsertNoteWithBullets({
      titleSummary: 'Soldering tips',
      categoryTag: 'Hardware',
      bullets: ['Tin the tip first'],
    });
    const archived = await repo.upsertNoteWithBullets({
      titleSummary: 'Kitchen renovation',
      categoryTag: 'home',
      bullets: ['Tile grout colour'],
    });
    await repo.softArchive(archived.id);

    expect(await repo.listNotes({ tag: 'HARDWARE' })).toHaveLength(2);
    expect(await repo.listTags()).toEqual([{ tag: 'Hardware', count: 2 }]);
    expect(await repo.listTags({ includeArchived: true })).toEqual([
      { tag: 'Hardware', count: 2 },
      { tag: 'home', count: 1 },
    ]);
  });

  /* ---------------------------------------------------------------- bullets */

  it('appends after the highest order_index, not after the bullet count', async () => {
    const note = await seedRobotics();
    expectOk(await repo.removeBullet(note.bullets[0]!.id));

    const updated = expectOk(await repo.appendBullets(note.id, ['Use M3 screws']));
    expect(updated.bullets.map((b) => [b.content, b.orderIndex])).toEqual([
      ['Order 2 servo horns', 1],
      ['Use M3 screws', 2],
    ]);
  });

  it('appends several bullets in the order they were said', async () => {
    const note = await seedRobotics();
    const updated = expectOk(
      await repo.appendBullets(note.id, ['Charge the battery', 'Flash firmware'], 'todo'),
    );
    expect(updated.bullets.slice(2).map((b) => [b.content, b.orderIndex, b.bulletKind])).toEqual([
      ['Charge the battery', 2, 'todo'],
      ['Flash firmware', 3, 'todo'],
    ]);
  });

  it('gives every bullet its own order_index when two appends overlap', async () => {
    const note = await seedRobotics();
    // Both calls are in flight at once: if they share one transaction they both
    // read the same max(order_index) and land on top of each other.
    await Promise.all([
      repo.appendBullets(note.id, ['Charge the battery']),
      repo.appendBullets(note.id, ['Flash firmware']),
    ]);

    const after = await repo.getNote(note.id);
    expect(after!.bullets.map((b) => b.orderIndex)).toEqual([0, 1, 2, 3]);
    expect(after!.bullets.map((b) => b.content).sort()).toEqual([
      'Charge the battery',
      'Flash firmware',
      'Order 2 servo horns',
      'Print the chassis',
    ]);
  });

  it('rejects appends to a missing note and blank bullet text', async () => {
    const note = await seedRobotics();
    expect(expectErr(await repo.appendBullets('nope', ['x'])).code).toBe('not_found');
    expect(expectErr(await repo.appendBullets(note.id, ['   '])).code).toBe('invalid_input');
    expect(expectOk(await repo.appendBullets(note.id, [])).bullets).toHaveLength(2);
  });

  it('toggles a bullet into a completed checkbox and back', async () => {
    const note = await seedRobotics();
    const id = note.bullets[0]!.id;

    const checked = expectOk(await repo.toggleBullet(id, true));
    expect([checked.isCompleted, checked.bulletKind]).toEqual([true, 'todo']);

    const unchecked = expectOk(await repo.toggleBullet(id));
    expect(unchecked.isCompleted).toBe(false);
    expect((await repo.getNote(note.id))!.bullets[0]!.isCompleted).toBe(false);
  });

  it('edits and removes bullets', async () => {
    const note = await seedRobotics();
    expectOk(await repo.updateBullet(note.bullets[0]!.id, '  Print the chassis in PETG  '));
    expect(expectErr(await repo.updateBullet(note.bullets[0]!.id, ' ')).code).toBe('invalid_input');

    expectOk(await repo.removeBullet(note.bullets[1]!.id));
    const after = await repo.getNote(note.id);
    expect(after!.bullets.map((b) => b.content)).toEqual(['Print the chassis in PETG']);
    expect(expectErr(await repo.removeBullet('nope')).code).toBe('not_found');
  });

  it('reorders bullets and rejects incomplete orderings', async () => {
    const note = await repo.upsertNoteWithBullets({
      titleSummary: 'Packing',
      categoryTag: 'trips',
      bullets: ['Passport', 'Charger', 'Toothbrush'],
    });
    const [a, b, c] = note.bullets.map((bullet) => bullet.id) as [string, string, string];

    const reordered = expectOk(await repo.reorderBullets(note.id, [c, a, b]));
    expect(reordered.map((bullet) => bullet.content)).toEqual(['Toothbrush', 'Passport', 'Charger']);
    expect(reordered.map((bullet) => bullet.orderIndex)).toEqual([0, 1, 2]);
    expect((await repo.getNote(note.id))!.bullets.map((bullet) => bullet.content)).toEqual([
      'Toothbrush',
      'Passport',
      'Charger',
    ]);

    expect(expectErr(await repo.reorderBullets(note.id, [c, a])).code).toBe('invalid_input');
    expect(expectErr(await repo.reorderBullets(note.id, [c, a, a])).code).toBe('invalid_input');
    expect(expectErr(await repo.reorderBullets(note.id, [c, a, newId()])).code).toBe(
      'invalid_input',
    );
    // A rejected reorder must not have half-applied.
    expect((await repo.getNote(note.id))!.bullets[0]!.content).toBe('Toothbrush');
  });

  /* --------------------------------------------------------------- updating */

  it('renames, re-tags and pins a note', async () => {
    const note = await seedRobotics();
    at(5_000);
    const updated = expectOk(
      await repo.updateNote(note.id, {
        titleSummary: 'Robot arm log',
        categoryTag: 'projects',
        isPinned: true,
      }),
    );
    expect([updated.titleSummary, updated.categoryTag, updated.isPinned]).toEqual([
      'Robot arm log',
      'projects',
      true,
    ]);
    expect(updated.updatedAt).toBe(T0 + 5_000);
    expect(expectOk(await repo.resolveNote('robot arm')).id).toBe(note.id);
  });

  it('refuses a rename that would collide with another note', async () => {
    await seedRobotics();
    const kitchen = await repo.upsertNoteWithBullets({
      titleSummary: 'Kitchen renovation',
      categoryTag: 'home',
      bullets: ['Tile grout colour'],
    });

    const error = expectErr(
      await repo.updateNote(kitchen.id, {
        titleSummary: 'robotics build log',
        categoryTag: 'HARDWARE',
      }),
    );
    expect(error.code).toBe('conflict');
    expect((await repo.getNote(kitchen.id))!.titleSummary).toBe('Kitchen renovation');
  });

  /* --------------------------------------------------------------- deletion */

  it('refuses to delete without an explicit confirmation', async () => {
    const note = await seedRobotics();

    const unconfirmed = expectErr(await repo.deleteNote(note.id));
    expect(unconfirmed.code).toBe('invalid_input');
    expect(expectErr(await repo.deleteNote(note.id, { confirmed: false })).code).toBe(
      'invalid_input',
    );
    expect(await repo.getNote(note.id)).not.toBeNull();

    const deleted = expectOk(await repo.deleteNote(note.id, { confirmed: true }));
    expect(deleted.titleSummary).toBe('Robotics build log');
    expect(await repo.getNote(note.id)).toBeNull();
    expect(countRows(t, 'note_bullets')).toBe(0);
    expect(countRows(t, 'notes_fts')).toBe(0);
    expect(expectErr(await repo.deleteNote(note.id, { confirmed: true })).code).toBe('not_found');
  });

  /* ----------------------------------------------------------------- search */

  it('escapes FTS operators out of the user query', () => {
    expect(escapeFtsQuery('M3 screws (2)')).toBe('"M3" OR "screws"* OR "2"');
    expect(escapeFtsQuery('he said "no" AND *')).toBe('"he" OR "said"* OR "no" OR "AND"*');
    expect(escapeFtsQuery('  ***  ')).toBeNull();
  });

  it('searches with FTS5 and survives queries full of FTS syntax', async () => {
    expect(repo.isFtsEnabled()).toBe(true);
    await seedRobotics();
    await repo.upsertNoteWithBullets({
      titleSummary: 'Kitchen renovation',
      categoryTag: 'home',
      bullets: ['Tile grout colour', 'Call the plumber'],
    });
    expectOk(await repo.appendBullets((await repo.listNotes())[1]!.id, ['Use M3 screws']));

    const hits = await repo.searchNotes('M3 screws (2)');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.note.titleSummary).toBe('Robotics build log');
    expect(hits[0]!.score).toBeGreaterThan(0);

    // Every one of these would be a MATCH syntax error if passed through raw.
    for (const nasty of ['"unterminated', 'grout AND OR NOT', 'colour^ (tile)', '- * :', '""']) {
      await expect(repo.searchNotes(nasty)).resolves.toBeDefined();
    }
    expect((await repo.searchNotes('"grout"')).map((h) => h.note.titleSummary)).toEqual([
      'Kitchen renovation',
    ]);
  });

  it('keeps the FTS index in step with every edit', async () => {
    const note = await seedRobotics();
    const bulletId = note.bullets[0]!.id;
    expect(countRows(t, 'notes_fts')).toBe(1);

    expectOk(await repo.updateBullet(bulletId, 'Print the chassis in PETG'));
    expect((await repo.searchNotes('PETG')).map((h) => h.note.id)).toEqual([note.id]);

    expectOk(await repo.removeBullet(bulletId));
    expect(await repo.searchNotes('PETG')).toHaveLength(0);

    expectOk(await repo.updateNote(note.id, { titleSummary: 'Hexapod build log' }));
    expect((await repo.searchNotes('hexapod')).map((h) => h.note.id)).toEqual([note.id]);
    expect(countRows(t, 'notes_fts')).toBe(1);

    expectOk(await repo.softArchive(note.id));
    expect(await repo.searchNotes('hexapod')).toHaveLength(0);
    expect(await repo.searchNotes('hexapod', 20, { includeArchived: true })).toHaveLength(1);
  });

  it('rebuilds the search index from scratch', async () => {
    await seedRobotics();
    await repo.upsertNoteWithBullets({
      titleSummary: 'Kitchen renovation',
      categoryTag: 'home',
      bullets: ['Tile grout colour'],
    });

    t.client.execSync('DELETE FROM notes_fts');
    expect(await repo.searchNotes('grout')).toHaveLength(0);

    expect(await repo.rebuildSearchIndex()).toBe(2);
    expect(countRows(t, 'notes_fts')).toBe(2);
    expect((await repo.searchNotes('grout')).map((h) => h.note.titleSummary)).toEqual([
      'Kitchen renovation',
    ]);
  });

  it('falls back to LIKE scanning when notes_fts does not exist', async () => {
    const plain = createTestDatabase();
    plain.client.execSync('DROP TABLE notes_fts');
    const fallback = createNotesRepository(plain.db);
    expect(fallback.isFtsEnabled()).toBe(false);

    try {
      await fallback.upsertNoteWithBullets({
        titleSummary: 'Robotics build log',
        categoryTag: 'hardware',
        bullets: ['Use M3 screws', 'Order 2 servo horns'],
      });
      await fallback.upsertNoteWithBullets({
        titleSummary: 'Kitchen renovation',
        categoryTag: 'home',
        bullets: ['Tile grout colour'],
      });

      const hits = await fallback.searchNotes('M3 screws (2)');
      expect(hits.map((h) => h.note.titleSummary)).toEqual(['Robotics build log']);
      expect((await fallback.searchNotes('GROUT')).map((h) => h.note.titleSummary)).toEqual([
        'Kitchen renovation',
      ]);
      expect(await fallback.searchNotes('nothing here')).toHaveLength(0);
      // Wildcards must be literal text, not LIKE wildcards.
      expect(await fallback.searchNotes('%')).toHaveLength(0);
      expect(await fallback.rebuildSearchIndex()).toBe(0);
    } finally {
      plain.close();
    }
  });
});
