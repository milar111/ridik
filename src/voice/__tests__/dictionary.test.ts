/**
 * The personal dictionary.
 *
 * The failure it exists for is the one nothing downstream can recover from: a
 * recogniser that has never heard the user's colleague, company or list name
 * returns the nearest word it does know, and every layer under it — the model,
 * the executor, the receipt — then works faithfully from the wrong word. A
 * competitor's four-star review is exactly this ("the AI summaries get my
 * company name wrong all over the place"), and it is the one bug a user cannot
 * work around by speaking more clearly.
 *
 * Two properties are worth holding: the list is *ranked and capped*, because a
 * bias list is a hint that stops helping past a hundred or so entries, and the
 * ranking is *fair across sources*, because a user with three hundred contacts
 * must still get the name of the list they dictate into every day.
 */
import { freezeClock } from '@/core/clock';
import { localToEpoch, setZoneOverride } from '@/core/time';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createRepositories, type Repositories } from '@/repositories';
import {
  buildContextualStrings,
  DICTIONARY_QUOTAS,
  MAX_ENTRY_CHARS,
  MAX_ENTRY_WORDS,
  readContextualStrings,
  readPersonalNames,
  toBiasEntry,
} from '@/voice/dictionary';
import { CONTEXTUAL_STRINGS_CAP } from '@/voice/types';

const SOFIA = 'Europe/Sofia';
const NOW = localToEpoch('2026-03-15T12:00', SOFIA);

describe('what earns a slot', () => {
  it('keeps a name and drops what a recogniser cannot be biased towards', () => {
    expect(toBiasEntry('  Professor   Dimitrov ')).toBe('Professor Dimitrov');
    expect(toBiasEntry('Ридик')).toBe('Ридик');

    expect(toBiasEntry('')).toBeNull();
    expect(toBiasEntry('  ')).toBeNull();
    expect(toBiasEntry('x')).toBeNull();
    // Digits have no pronunciation to bias: a list called "2024" is already
    // exactly what the engine will hear.
    expect(toBiasEntry('2024')).toBeNull();
    expect(toBiasEntry('—')).toBeNull();
    expect(toBiasEntry(undefined)).toBeNull();
  });

  /* A bias entry is a phrase. A sentence spends a slot on something that can
     never match, and the slots are the scarce thing. */
  it('refuses a sentence', () => {
    expect(toBiasEntry('a'.repeat(MAX_ENTRY_CHARS))).not.toBeNull();
    expect(toBiasEntry('a'.repeat(MAX_ENTRY_CHARS + 1))).toBeNull();
    expect(toBiasEntry(Array(MAX_ENTRY_WORDS).fill('one').join(' '))).not.toBeNull();
    expect(toBiasEntry(Array(MAX_ENTRY_WORDS + 1).fill('one').join(' '))).toBeNull();
  });
});

describe('ranking and the cap', () => {
  const many = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${prefix}${i}`);

  it('leads with people and keeps every source in its own order', () => {
    const list = buildContextualStrings({
      people: [{ name: 'Ivo Petrov' }, { name: 'Maria Ivanova' }],
      projects: ['Drone build'],
      checklists: ['Hardware'],
      places: ['The lab'],
      habits: ['Running'],
    });

    expect(list).toEqual([
      'Ivo Petrov',
      'Maria Ivanova',
      'Drone build',
      'Hardware',
      'The lab',
      'Running',
    ]);
  });

  it('caps the list, because a bias list is a hint and an oversized one hurts', () => {
    const list = buildContextualStrings({
      people: many('Person ', 500).map((name) => ({ name })),
      checklists: many('List ', 50),
    });

    expect(list).toHaveLength(CONTEXTUAL_STRINGS_CAP);
  });

  /* The whole reason for per-source quotas. Straight truncation of a
     people-first list would spend all hundred slots on contacts and never
     mention the list the user dictates into every morning. */
  it('does not let one source crowd out the others', () => {
    const list = buildContextualStrings({
      people: many('Person ', 500).map((name) => ({ name })),
      projects: many('Project ', 50),
      checklists: many('List ', 50),
      places: many('Place ', 50),
      habits: many('Habit ', 50),
    });

    expect(list.filter((entry) => entry.startsWith('Person'))).toHaveLength(
      DICTIONARY_QUOTAS.people,
    );
    expect(list.filter((entry) => entry.startsWith('List'))).toHaveLength(
      DICTIONARY_QUOTAS.checklists,
    );
    expect(list).toHaveLength(CONTEXTUAL_STRINGS_CAP);
  });

  /* …and the other half of that rule: an unspent quota is not a wasted one. */
  it('hands the leftovers to whoever has names left', () => {
    const list = buildContextualStrings({
      people: [{ name: 'Ivo Petrov' }],
      checklists: many('List ', 200),
    });

    expect(list).toHaveLength(CONTEXTUAL_STRINGS_CAP);
    expect(list[0]).toBe('Ivo Petrov');
    expect(list.filter((entry) => entry.startsWith('List')).length).toBe(
      CONTEXTUAL_STRINGS_CAP - 1,
    );
  });

  it('gives everyone a name before anyone gets an alias', () => {
    const list = buildContextualStrings({
      people: [
        { name: 'Maria Ivanova', aliases: ['Mum'] },
        { name: 'Georgi Dimitrov', aliases: ['The professor'] },
      ],
    });

    expect(list).toEqual(['Maria Ivanova', 'Georgi Dimitrov', 'Mum', 'The professor']);
  });

  it('spends a slot once when two sources share a name', () => {
    const list = buildContextualStrings({
      people: [{ name: 'Vitosha' }],
      places: ['vitosha', 'The lab'],
    });

    expect(list).toEqual(['Vitosha', 'The lab']);
  });
});

describe('reading the user\'s own nouns', () => {
  let t: TestDatabase;
  let repos: Repositories;
  let restoreClock: () => void;

  beforeEach(() => {
    t = createTestDatabase();
    repos = createRepositories(t.db);
    restoreClock = freezeClock(NOW);
    setZoneOverride(SOFIA);
  });

  afterEach(() => {
    restoreClock();
    setZoneOverride(null);
    t.close();
  });

  it('collects names from all five sources', async () => {
    await repos.crm.getOrCreateEntity('Ivo Petrov');
    await repos.projects.createProject({ name: 'Drone build', kind: 'project' });
    await repos.checklists.addItems('Hardware', ['10k resistors']);
    await repos.places.upsertPlace({ label: 'The lab', latitude: 42.65, longitude: 23.37 });
    await repos.habits.getOrCreateHabit('Bouldering');

    const list = await readContextualStrings(repos);

    expect(list).toEqual(
      expect.arrayContaining(['Ivo Petrov', 'Drone build', 'Hardware', 'The lab', 'Bouldering']),
    );
  });

  /* Whose name is about to be said is not a database order. The person you
     spoke to yesterday and the one you owe something to are the two signals
     available, and both beat alphabetical. */
  it('ranks people by who you last spoke to and what you still owe', async () => {
    await repos.crm.getOrCreateEntity('Zdravko Alphabetically Last');
    await repos.crm.logInteraction({
      entityName: 'Ivo Petrov',
      summary: 'CAD files',
      occurredAt: NOW - 60_000,
    });
    await repos.crm.addCommitment({
      entityName: 'Maria Ivanova',
      commitmentText: 'Send the invoice',
    });

    const names = (await readPersonalNames(repos)).people?.map((person) => person.name);

    expect(names?.[0]).toBe('Ivo Petrov');
    expect(names).toContain('Maria Ivanova');
  });

  it('carries the alias, which is what the user actually says', async () => {
    const entity = await repos.crm.getOrCreateEntity('Maria Ivanova');
    await repos.crm.addAlias(entity.id, 'Mum');

    expect(await readContextualStrings(repos)).toEqual(
      expect.arrayContaining(['Maria Ivanova', 'Mum']),
    );
  });

  /* A biased recogniser is an improvement, never a dependency: the microphone
     has to open on a database that cannot answer. */
  it('degrades to nothing rather than costing the user the utterance', async () => {
    const broken = {
      crm: {
        listEntities: () => {
          throw new Error('no such table');
        },
      },
      projects: { listProjects: async () => Promise.reject(new Error('locked')) },
      checklists: { listNames: async () => [{ name: 'Hardware', open: 1, total: 2 }] },
      places: {},
      habits: { listHabits: async () => [] },
    } as unknown as Repositories;

    await expect(readContextualStrings(broken)).resolves.toEqual(['Hardware']);
  });
});
