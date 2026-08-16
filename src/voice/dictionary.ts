/**
 * The personal dictionary — the words the recogniser has never heard.
 *
 * A speech engine is a language model over a general vocabulary. It has never
 * met the user's colleague, their company, the name they gave a list or a
 * project, and it will confidently return the nearest common word instead:
 * "Ridik" becomes "ridic", "Vitosha" becomes "Vitosia", and the receipt is
 * plausible and wrong. Both platforms take a bias list for exactly this —
 * `SFSpeechRecognitionRequest.contextualStrings` on iOS, `EXTRA_BIASING_STRINGS`
 * on Android 13+ — and this module decides what goes in it.
 *
 * Three properties matter:
 *
 *  - **Pure.** Nothing here imports a native module or reads a clock. The
 *    reader takes repositories as an argument (they are pure too), so the
 *    ranking can be exercised under plain Node against a real database rather
 *    than reasoned about.
 *  - **Ranked, then truncated.** The list is a hint, not a dictionary: iOS
 *    documents it as something to keep small, and Android's extra is a hint the
 *    recogniser may ignore or truncate. Past a few hundred entries a bias list
 *    stops helping and starts pulling ordinary words towards the user's nouns,
 *    so `CONTEXTUAL_STRINGS_CAP` is the ceiling and every source has a quota
 *    under it. A user with 300 contacts must still get their list names.
 *  - **Never fatal.** Every read is individually guarded. A biased recogniser
 *    is an improvement, not a dependency, and one unhappy table must not cost
 *    the user the ability to speak.
 *
 * What is deliberately *not* in here: note titles, task titles, event titles
 * and spending categories. They are sentences and common nouns rather than
 * names — they would spend the cap on words the engine already knows, and
 * biasing towards a whole phrase is how "I ran five k" turns into a note title.
 */
import type { Repositories } from '@/repositories';
import { CONTEXTUAL_STRINGS_CAP } from './types';

/**
 * The five sources, and what each is worth.
 *
 * People lead because a person's name is the entry a general vocabulary is
 * least likely to contain and the one whose mis-hearing does the most damage —
 * it lands on a CRM row, a commitment and a task at once. Habits trail because
 * they are usually ordinary verbs ("running", "reading") that the engine knows
 * perfectly well already.
 *
 * The quotas sum to the cap, so a full set of every kind is exactly the
 * ceiling; whatever a kind does not use is redistributed in this same order.
 */
export const DICTIONARY_QUOTAS = {
  people: 40,
  projects: 15,
  checklists: 15,
  places: 15,
  habits: 15,
} as const;

export type DictionarySource = keyof typeof DICTIONARY_QUOTAS;

/** Priority order for the leftovers, and the order entries appear in. */
export const DICTIONARY_ORDER: readonly DictionarySource[] = [
  'people',
  'projects',
  'checklists',
  'places',
  'habits',
];

/**
 * Bias entries are phrases, not sentences. A recogniser can be nudged towards
 * "Professor Dimitrov"; it cannot be nudged towards a paragraph, and trying
 * spends the cap on something that will never match.
 */
export const MAX_ENTRY_CHARS = 48;
export const MAX_ENTRY_WORDS = 4;
const MIN_ENTRY_CHARS = 2;

export type PersonalName = {
  name: string;
  /** What the user actually calls them — "Mum", "the professor". */
  aliases?: readonly string[];
};

/** One list per source, each already in the order that source considers useful. */
export type PersonalNames = {
  people?: readonly PersonalName[];
  projects?: readonly string[];
  checklists?: readonly string[];
  places?: readonly string[];
  habits?: readonly string[];
};

/**
 * Trims an entry down to something a recogniser can bias towards, or rejects
 * it. `null` means "not worth one of the hundred slots".
 */
export function toBiasEntry(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length < MIN_ENTRY_CHARS || flat.length > MAX_ENTRY_CHARS) return null;
  // Digits and punctuation carry no pronunciation the engine can be biased
  // towards: a list called "2024" is already exactly what it will hear.
  if (!/\p{L}/u.test(flat)) return null;
  if (flat.split(' ').length > MAX_ENTRY_WORDS) return null;
  return flat;
}

/**
 * Ranks, dedupes and truncates the user's own nouns into one bias list.
 *
 * Per source: its own order is preserved, because each repository already puts
 * the useful end first. Across sources: each takes its quota, then whatever is
 * left over is handed out in `DICTIONARY_ORDER`, so a user with two contacts
 * gets more of everything else and a user with three hundred still gets their
 * lists.
 *
 * A person contributes their name before anybody contributes an alias: within
 * a full quota, one entry each beats two entries for the first twenty people.
 */
export function buildContextualStrings(input: PersonalNames): string[] {
  const pools: Record<DictionarySource, string[]> = {
    people: [
      ...(input.people ?? []).map((person) => person.name),
      ...(input.people ?? []).flatMap((person) => [...(person.aliases ?? [])]),
    ],
    projects: [...(input.projects ?? [])],
    checklists: [...(input.checklists ?? [])],
    places: [...(input.places ?? [])],
    habits: [...(input.habits ?? [])],
  };

  const seen = new Set<string>();
  const out: string[] = [];

  const take = (source: DictionarySource, limit: number): number => {
    let taken = 0;
    const pool = pools[source];
    while (pool.length > 0 && taken < limit && out.length < CONTEXTUAL_STRINGS_CAP) {
      const entry = toBiasEntry(pool.shift());
      if (entry === null) continue;
      const key = entry.toLowerCase();
      // A person named after their project is one entry, not two: the engine
      // gains nothing from the repeat and the second slot is gone.
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
      taken++;
    }
    return taken;
  };

  for (const source of DICTIONARY_ORDER) take(source, DICTIONARY_QUOTAS[source]);
  // Second pass: the cap is a budget, not five budgets. Whatever the quotas
  // left unspent goes to whoever still has names, strongest source first.
  for (const source of DICTIONARY_ORDER) take(source, CONTEXTUAL_STRINGS_CAP);

  return out;
}

/* -------------------------------------------------------------- the reader -- */

export type DictionaryRepositories = Pick<
  Repositories,
  'checklists' | 'crm' | 'habits' | 'places' | 'projects'
>;

/** A read that fails costs its own source and nothing else. */
async function safely<T>(fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback;
  }
}

/**
 * Reads the five sources and puts each in its own most-useful-first order.
 *
 * Only people need re-ordering: the other four repositories already answer in
 * an order that means something (a list with open items first, a project by
 * how recently it was touched, and the two alphabetical ones are small). A
 * person is ranked by when you last spoke to them and by what you still owe
 * them, because that is what predicts whose name is about to be said.
 */
export async function readPersonalNames(repos: DictionaryRepositories): Promise<PersonalNames> {
  const [people, projects, lists, places, habits] = await Promise.all([
    safely([], () => repos.crm.listEntities()),
    safely([], () => repos.projects.listProjects()),
    safely([], () => repos.checklists.listNames()),
    safely([], () => repos.places.listPlaces()),
    safely([], () => repos.habits.listHabits()),
  ]);

  return {
    people: [...people]
      .sort(
        (a, b) =>
          (b.lastInteractionAt ?? 0) - (a.lastInteractionAt ?? 0) ||
          b.openCommitments - a.openCommitments ||
          a.entity.name.localeCompare(b.entity.name),
      )
      .map((row) => ({ name: row.entity.name, aliases: row.aliases })),
    projects: projects.map((project) => project.name),
    checklists: [...lists]
      .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name))
      .map((list) => list.name),
    places: places.map((place) => place.label),
    habits: habits.map((habit) => habit.name),
  };
}

/**
 * The whole job: what to hand `contextualStrings` for this session.
 *
 * Never throws and never rejects — the worst case is an empty list, which is
 * exactly the behaviour every build had before this existed.
 */
export async function readContextualStrings(repos: DictionaryRepositories): Promise<string[]> {
  return buildContextualStrings(await readPersonalNames(repos));
}
