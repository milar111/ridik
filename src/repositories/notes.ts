/**
 * Structured notes: a title, a tag, and ordered bullets that may be checkboxes.
 *
 * Two product rules shape this file.
 *
 * Creation date is never an ordering or search key. The user thinks in terms of
 * "the note I keep adding to", so everything is exposed pinned-first then by
 * how recently the note was *touched*.
 *
 * "Add to my Robotics note" must land in the note that already exists. Every
 * write path therefore goes through either fuzzy resolution (`resolveNote`) or
 * the case-insensitive (title, tag) unique index (`upsertNoteWithBullets`)
 * rather than blindly inserting a near-duplicate.
 *
 * We also own the `notes_fts` index by hand: FTS5 is a compile-time SQLite
 * option, so the table may not exist at all and every mutation has to keep the
 * one-row-per-note projection in step (or the search results start lying).
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { now } from '@/core/clock';
import { resolveOne, scoreText, type Candidate, type MatchOptions } from '@/core/match';
import { AppError, fail, ok, type Result } from '@/core/result';
import { newId } from '@/db/ids';
import type { RidikDatabase } from '@/db/migrator';
import { noteBullets, notes, type Note, type NoteBullet } from '@/db/schema';

export type BulletKind = 'text' | 'todo';

export type BulletInput = string | { content: string; kind?: BulletKind; isCompleted?: boolean };

export type NoteWithBullets = Note & { bullets: NoteBullet[] };

export type ListNotesOptions = {
  tag?: string;
  /** `null` selects notes with no project; omit for "any project". */
  projectId?: string | null;
  includeArchived?: boolean;
  limit?: number;
};

export type TagCount = { tag: string; count: number };

export type NoteSearchHit = {
  note: NoteWithBullets;
  /** Higher is better. The scale differs between the FTS and LIKE backends. */
  score: number;
};

export type ResolveNoteOptions = MatchOptions & { includeArchived?: boolean };

export type NoteCandidateSummary = {
  id: string;
  titleSummary: string;
  categoryTag: string;
  score: number;
};

export type UpsertNoteInput = {
  titleSummary: string;
  categoryTag: string;
  bullets: BulletInput[];
  projectId?: string | null;
  /** Default kind for bullets passed as plain strings. */
  bulletKind?: BulletKind;
};

export type NotePatch = {
  titleSummary?: string;
  categoryTag?: string;
  projectId?: string | null;
  isPinned?: boolean;
};

type NormalisedBullet = { content: string; kind: BulletKind; isCompleted: boolean };

const FTS_TABLE = 'notes_fts';
/** Ceiling on rows the LIKE fallback pulls into memory to score. */
const LIKE_SCAN_LIMIT = 200;

function normaliseBullets(
  inputs: readonly BulletInput[],
  defaultKind: BulletKind,
): NormalisedBullet[] {
  const out: NormalisedBullet[] = [];
  for (const input of inputs) {
    const raw: { content: string; kind?: BulletKind; isCompleted?: boolean } =
      typeof input === 'string' ? { content: input } : input;
    const content = raw.content.trim();
    if (!content) continue;
    out.push({
      content,
      kind: raw.kind ?? defaultKind,
      isCompleted: raw.isCompleted ?? false,
    });
  }
  return out;
}

/** Alphanumeric tokens only — the raw utterance may contain anything. */
function searchTokens(query: string): string[] {
  return query
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Builds a safe FTS5 MATCH expression.
 *
 * The query is a raw transcription: "M3 screws (2)" or `he said "no"` must not
 * become a syntax error. Stripping everything but letters and digits and then
 * quoting each token means no character can ever escape into operator
 * position; OR keeps recall high for speech, and bm25 sorts out the ranking.
 */
export function escapeFtsQuery(query: string): string | null {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return null;
  // Prefix-match longer tokens so "robot" still finds "robotics".
  return tokens.map((t) => (t.length >= 3 ? `"${t}"*` : `"${t}"`)).join(' OR ');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function isUniqueViolation(error: unknown): boolean {
  // SQLite's error is raised by the native driver, so under Jest it is an Error
  // from another realm and `instanceof` lies. Match the guaranteed message.
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);
  return /unique constraint/i.test(message);
}

export function createNotesRepository(db: RidikDatabase) {
  const client = db.$client;

  let ftsProbe: boolean | null = null;
  /**
   * Migration 2 is skipped when the runtime lacks FTS5, so the table's presence
   * — not the migration list — is the truth. Probed once: it cannot appear or
   * vanish while the app is running.
   */
  function ftsAvailable(): boolean {
    if (ftsProbe === null) {
      const row = client.getFirstSync<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        [FTS_TABLE],
      );
      ftsProbe = row !== null;
    }
    return ftsProbe;
  }

  let pending: Promise<unknown> = Promise.resolve();
  /**
   * SQLite has no nested transactions, and these bodies await between
   * statements — so two overlapping calls must not share one BEGIN. Letting the
   * second caller join the first's transaction silently renumbers bullets
   * (both read the same `max(order_index)`) and lets one caller's failure roll
   * back another caller's committed-looking write. Each transaction therefore
   * queues behind the previous one. No method below may call another
   * transactional method: the wait would never end.
   */
  function transact<T>(run: () => Promise<T>): Promise<T> {
    const result = pending.then(async () => {
      client.execSync('BEGIN');
      try {
        const value = await run();
        client.execSync('COMMIT');
        return value;
      } catch (error) {
        client.execSync('ROLLBACK');
        throw error;
      }
    });
    // The queue only orders work; a failure must not poison later callers.
    pending = result.catch(() => undefined);
    return result;
  }

  async function bulletsByNote(noteIds: string[]): Promise<Map<string, NoteBullet[]>> {
    const grouped = new Map<string, NoteBullet[]>();
    if (noteIds.length === 0) return grouped;
    const rows = await db
      .select()
      .from(noteBullets)
      .where(inArray(noteBullets.noteId, noteIds))
      .orderBy(asc(noteBullets.orderIndex), asc(noteBullets.id));
    for (const row of rows) {
      const existing = grouped.get(row.noteId);
      if (existing) existing.push(row);
      else grouped.set(row.noteId, [row]);
    }
    return grouped;
  }

  async function hydrate(rows: Note[]): Promise<NoteWithBullets[]> {
    const grouped = await bulletsByNote(rows.map((row) => row.id));
    return rows.map((row) => ({ ...row, bullets: grouped.get(row.id) ?? [] }));
  }

  async function loadNote(id: string): Promise<NoteWithBullets | null> {
    const [row] = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
    if (!row) return null;
    const [hydrated] = await hydrate([row]);
    return hydrated ?? null;
  }

  function bodyOf(note: NoteWithBullets): string {
    return note.bullets.map((bullet) => bullet.content).join('\n');
  }

  function writeFtsRow(note: NoteWithBullets): void {
    client.runSync('DELETE FROM notes_fts WHERE note_id = ?', [note.id]);
    client.runSync('INSERT INTO notes_fts (note_id, title, tag, body) VALUES (?, ?, ?, ?)', [
      note.id,
      note.titleSummary,
      note.categoryTag,
      bodyOf(note),
    ]);
  }

  /** Rebuilds the note's single index row. Always called inside the writer's transaction. */
  async function syncFts(noteId: string): Promise<void> {
    if (!ftsAvailable()) return;
    const note = await loadNote(noteId);
    if (!note) {
      client.runSync('DELETE FROM notes_fts WHERE note_id = ?', [noteId]);
      return;
    }
    writeFtsRow(note);
  }

  async function nextOrderIndex(noteId: string): Promise<number> {
    const rows = await db
      .select({ highest: sql<number | null>`max(${noteBullets.orderIndex})` })
      .from(noteBullets)
      .where(eq(noteBullets.noteId, noteId));
    return (rows[0]?.highest ?? -1) + 1;
  }

  /** Caller must already hold a transaction: order_index is read-then-written. */
  async function appendUnsafe(
    noteId: string,
    bullets: NormalisedBullet[],
    at: number,
  ): Promise<void> {
    if (bullets.length === 0) return;
    let index = await nextOrderIndex(noteId);
    await db.insert(noteBullets).values(
      bullets.map((bullet) => ({
        id: newId(),
        noteId,
        content: bullet.content,
        orderIndex: index++,
        bulletKind: bullet.kind,
        isCompleted: bullet.isCompleted,
        createdAt: at,
      })),
    );
  }

  /** Adding content to an archived note is an implicit "I still use this". */
  async function touchAfterAppend(
    noteId: string,
    at: number,
    extra: Partial<typeof notes.$inferInsert> = {},
  ): Promise<void> {
    await db
      .update(notes)
      .set({ updatedAt: at, isArchived: false, ...extra })
      .where(eq(notes.id, noteId));
  }

  async function setArchived(id: string, archived: boolean): Promise<Result<NoteWithBullets>> {
    const existing = await loadNote(id);
    if (!existing) return fail('not_found', 'I could not find that note.');
    const at = now();
    await db.update(notes).set({ isArchived: archived, updatedAt: at }).where(eq(notes.id, id));
    return ok({ ...existing, isArchived: archived, updatedAt: at });
  }

  /* ------------------------------------------------------------------ reads */

  async function getNote(id: string): Promise<NoteWithBullets | null> {
    return loadNote(id);
  }

  async function listNotes(options: ListNotesOptions = {}): Promise<NoteWithBullets[]> {
    const conditions = [];
    if (!options.includeArchived) conditions.push(eq(notes.isArchived, false));
    if (options.tag !== undefined) {
      conditions.push(sql`${notes.categoryTag} COLLATE NOCASE = ${options.tag.trim()}`);
    }
    if (options.projectId === null) conditions.push(isNull(notes.projectId));
    else if (options.projectId !== undefined) conditions.push(eq(notes.projectId, options.projectId));

    const rows = await db
      .select()
      .from(notes)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      // Title, not id, breaks ties: an id sorts by creation time, and creation
      // time must never influence where a note appears.
      .orderBy(desc(notes.isPinned), desc(notes.updatedAt), asc(notes.titleSummary))
      // SQLite reads a negative LIMIT as "no limit".
      .limit(options.limit ?? -1);
    return hydrate(rows);
  }

  async function listTags(options: { includeArchived?: boolean } = {}): Promise<TagCount[]> {
    return db
      .select({
        // Tags are matched case-insensitively, so collapse spellings and pick a
        // stable representative rather than listing "Hardware" twice.
        tag: sql<string>`min(${notes.categoryTag})`,
        count: sql<number>`count(*)`,
      })
      .from(notes)
      .where(options.includeArchived ? undefined : eq(notes.isArchived, false))
      .groupBy(sql`${notes.categoryTag} COLLATE NOCASE`)
      .orderBy(sql`count(*) desc`, sql`min(${notes.categoryTag}) asc`);
  }

  /**
   * Resolves a spoken reference ("my robotics note") to exactly one note.
   * Title carries the match; tag and bullet text are secondary evidence.
   */
  async function resolveNote(
    query: string,
    options: ResolveNoteOptions = {},
  ): Promise<Result<NoteWithBullets>> {
    const trimmed = query.trim();
    if (!trimmed) return fail('invalid_input', 'I did not catch which note you meant.');

    const rows = await db
      .select()
      .from(notes)
      .where(options.includeArchived ? undefined : eq(notes.isArchived, false));
    const candidates: Candidate<NoteWithBullets>[] = (await hydrate(rows)).map((note) => ({
      item: note,
      text: note.titleSummary,
      aux: [note.categoryTag, ...note.bullets.map((bullet) => bullet.content)],
      boost: note.isPinned ? 1 : 0,
    }));

    const outcome = resolveOne(trimmed, candidates, options);
    if (outcome.kind === 'unique') return ok(outcome.match.item);
    if (outcome.kind === 'none') {
      return fail('not_found', `I could not find a note matching "${trimmed}".`);
    }
    const listed: NoteCandidateSummary[] = outcome.matches.map((match) => ({
      id: match.item.id,
      titleSummary: match.item.titleSummary,
      categoryTag: match.item.categoryTag,
      score: match.score,
    }));
    return fail('ambiguous', `I found ${listed.length} notes matching "${trimmed}". Which one?`, {
      details: { candidates: listed },
    });
  }

  /* ----------------------------------------------------------------- writes */

  /**
   * Creates the note, or appends to the one that already owns this
   * (title, tag) pair — the schema's unique index is case-insensitive, so
   * "Robotics/hardware" and "robotics/Hardware" are the same note.
   */
  async function upsertNoteWithBullets(input: UpsertNoteInput): Promise<NoteWithBullets> {
    const titleSummary = input.titleSummary.trim();
    const categoryTag = input.categoryTag.trim();
    if (!titleSummary || !categoryTag) {
      throw new AppError('invalid_input', 'A note needs both a title and a tag.');
    }
    const bullets = normaliseBullets(input.bullets, input.bulletKind ?? 'text');
    const at = now();

    const id = await transact(async () => {
      const [existing] = await db
        .select()
        .from(notes)
        .where(
          and(
            sql`${notes.titleSummary} COLLATE NOCASE = ${titleSummary}`,
            sql`${notes.categoryTag} COLLATE NOCASE = ${categoryTag}`,
          ),
        )
        .limit(1);

      if (existing) {
        await appendUnsafe(existing.id, bullets, at);
        await touchAfterAppend(
          existing.id,
          at,
          input.projectId !== undefined ? { projectId: input.projectId } : {},
        );
        await syncFts(existing.id);
        return existing.id;
      }

      const noteId = newId();
      await db.insert(notes).values({
        id: noteId,
        titleSummary,
        categoryTag,
        projectId: input.projectId ?? null,
        createdAt: at,
        updatedAt: at,
      });
      await appendUnsafe(noteId, bullets, at);
      await syncFts(noteId);
      return noteId;
    });

    const note = await loadNote(id);
    if (!note) throw new AppError('unknown', 'The note disappeared while it was being written.');
    return note;
  }

  async function appendBullets(
    noteId: string,
    contents: BulletInput[],
    kind: BulletKind = 'text',
  ): Promise<Result<NoteWithBullets>> {
    const existing = await loadNote(noteId);
    if (!existing) return fail('not_found', 'I could not find that note.');

    const bullets = normaliseBullets(contents, kind);
    if (bullets.length === 0) {
      if (contents.length === 0) return ok(existing);
      return fail('invalid_input', 'There was nothing to add to that note.');
    }

    const at = now();
    await transact(async () => {
      await appendUnsafe(noteId, bullets, at);
      await touchAfterAppend(noteId, at);
      await syncFts(noteId);
    });

    const note = await loadNote(noteId);
    return note ? ok(note) : fail('not_found', 'I could not find that note.');
  }

  async function updateNote(id: string, patch: NotePatch): Promise<Result<NoteWithBullets>> {
    const existing = await loadNote(id);
    if (!existing) return fail('not_found', 'I could not find that note.');

    const values: Partial<typeof notes.$inferInsert> = { updatedAt: now() };
    if (patch.titleSummary !== undefined) {
      const titleSummary = patch.titleSummary.trim();
      if (!titleSummary) return fail('invalid_input', 'A note needs a title.');
      values.titleSummary = titleSummary;
    }
    if (patch.categoryTag !== undefined) {
      const categoryTag = patch.categoryTag.trim();
      if (!categoryTag) return fail('invalid_input', 'A note needs a tag.');
      values.categoryTag = categoryTag;
    }
    if (patch.projectId !== undefined) values.projectId = patch.projectId;
    if (patch.isPinned !== undefined) values.isPinned = patch.isPinned;

    try {
      await transact(async () => {
        await db.update(notes).set(values).where(eq(notes.id, id));
        await syncFts(id);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return fail('conflict', 'Another note already uses that title and tag.', { cause: error });
      }
      throw error;
    }

    const note = await loadNote(id);
    return note ? ok(note) : fail('not_found', 'I could not find that note.');
  }

  /** Irreversible, and voice mishears — the caller must have asked out loud. */
  async function deleteNote(
    id: string,
    options: { confirmed?: boolean } = {},
  ): Promise<Result<{ id: string; titleSummary: string }>> {
    if (options.confirmed !== true) {
      return fail('invalid_input', 'Deleting a note needs an explicit confirmation.', {
        details: { requires: 'confirmation', noteId: id },
      });
    }
    const existing = await loadNote(id);
    if (!existing) return fail('not_found', 'I could not find that note.');

    await transact(async () => {
      await db.delete(notes).where(eq(notes.id, id)); // bullets cascade
      if (ftsAvailable()) client.runSync('DELETE FROM notes_fts WHERE note_id = ?', [id]);
    });
    return ok({ id, titleSummary: existing.titleSummary });
  }

  async function softArchive(id: string): Promise<Result<NoteWithBullets>> {
    return setArchived(id, true);
  }

  async function unarchiveNote(id: string): Promise<Result<NoteWithBullets>> {
    return setArchived(id, false);
  }

  /* ---------------------------------------------------------------- bullets */

  async function toggleBullet(
    bulletId: string,
    completed?: boolean,
  ): Promise<Result<NoteBullet>> {
    const [bullet] = await db
      .select()
      .from(noteBullets)
      .where(eq(noteBullets.id, bulletId))
      .limit(1);
    if (!bullet) return fail('not_found', 'I could not find that item.');

    const isCompleted = completed ?? !bullet.isCompleted;
    const at = now();
    await transact(async () => {
      // Checking something off is what turns a plain bullet into a checkbox.
      await db
        .update(noteBullets)
        .set({ isCompleted, bulletKind: 'todo' })
        .where(eq(noteBullets.id, bulletId));
      await db.update(notes).set({ updatedAt: at }).where(eq(notes.id, bullet.noteId));
    });
    // The indexed body is unchanged: completion is not searchable text.
    return ok({ ...bullet, isCompleted, bulletKind: 'todo' });
  }

  async function updateBullet(bulletId: string, content: string): Promise<Result<NoteBullet>> {
    const trimmed = content.trim();
    if (!trimmed) return fail('invalid_input', 'A bullet cannot be empty.');

    const [bullet] = await db
      .select()
      .from(noteBullets)
      .where(eq(noteBullets.id, bulletId))
      .limit(1);
    if (!bullet) return fail('not_found', 'I could not find that item.');

    const at = now();
    await transact(async () => {
      await db.update(noteBullets).set({ content: trimmed }).where(eq(noteBullets.id, bulletId));
      await db.update(notes).set({ updatedAt: at }).where(eq(notes.id, bullet.noteId));
      await syncFts(bullet.noteId);
    });
    return ok({ ...bullet, content: trimmed });
  }

  async function removeBullet(bulletId: string): Promise<Result<{ id: string }>> {
    const [bullet] = await db
      .select()
      .from(noteBullets)
      .where(eq(noteBullets.id, bulletId))
      .limit(1);
    if (!bullet) return fail('not_found', 'I could not find that item.');

    const at = now();
    await transact(async () => {
      await db.delete(noteBullets).where(eq(noteBullets.id, bulletId));
      await db.update(notes).set({ updatedAt: at }).where(eq(notes.id, bullet.noteId));
      await syncFts(bullet.noteId);
    });
    return ok({ id: bulletId });
  }

  async function reorderBullets(
    noteId: string,
    orderedIds: string[],
  ): Promise<Result<NoteBullet[]>> {
    const existing = await loadNote(noteId);
    if (!existing) return fail('not_found', 'I could not find that note.');

    const known = new Set(existing.bullets.map((bullet) => bullet.id));
    const unique = new Set(orderedIds);
    if (
      unique.size !== orderedIds.length ||
      orderedIds.length !== known.size ||
      orderedIds.some((id) => !known.has(id))
    ) {
      return fail('invalid_input', 'That reorder did not list every item exactly once.', {
        details: { expected: [...known], received: orderedIds },
      });
    }

    const at = now();
    await transact(async () => {
      for (let index = 0; index < orderedIds.length; index++) {
        await db
          .update(noteBullets)
          .set({ orderIndex: index })
          .where(eq(noteBullets.id, orderedIds[index]!));
      }
      await db.update(notes).set({ updatedAt: at }).where(eq(notes.id, noteId));
      await syncFts(noteId);
    });

    const note = await loadNote(noteId);
    return ok(note?.bullets ?? []);
  }

  /* ----------------------------------------------------------------- search */

  async function searchWithFts(
    query: string,
    limit: number,
    includeArchived: boolean,
  ): Promise<NoteSearchHit[]> {
    const match = escapeFtsQuery(query);
    if (!match) return [];
    // Over-fetch: archived notes are filtered out after ranking.
    const ranked = client.getAllSync<{ note_id: string; bm25_rank: number }>(
      `SELECT note_id, bm25(notes_fts, 0.0, 8.0, 4.0, 1.0) AS bm25_rank
         FROM notes_fts
        WHERE notes_fts MATCH ?
        ORDER BY bm25_rank
        LIMIT ?`,
      [match, Math.max(limit * 4, 40)],
    );
    if (ranked.length === 0) return [];

    const ids = ranked.map((row) => row.note_id);
    const rows = await db
      .select()
      .from(notes)
      .where(
        includeArchived
          ? inArray(notes.id, ids)
          : and(inArray(notes.id, ids), eq(notes.isArchived, false)),
      );
    const byId = new Map((await hydrate(rows)).map((note) => [note.id, note]));

    const hits: NoteSearchHit[] = [];
    for (const row of ranked) {
      const note = byId.get(row.note_id);
      if (!note) continue;
      // bm25 returns "more negative is better"; flip it so higher wins.
      hits.push({ note, score: -row.bm25_rank });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  async function searchWithLike(
    query: string,
    limit: number,
    includeArchived: boolean,
  ): Promise<NoteSearchHit[]> {
    const tokens = searchTokens(query);
    if (tokens.length === 0) return [];

    const matchers = tokens.map((token) => {
      const pattern = `%${escapeLike(token)}%`;
      return or(
        sql`${notes.titleSummary} LIKE ${pattern} ESCAPE '\\'`,
        sql`${notes.categoryTag} LIKE ${pattern} ESCAPE '\\'`,
        sql`EXISTS (SELECT 1 FROM ${noteBullets} b
                     WHERE b.note_id = ${notes.id} AND b.content LIKE ${pattern} ESCAPE '\\')`,
      );
    });

    const conditions = [or(...matchers)];
    if (!includeArchived) conditions.push(eq(notes.isArchived, false));
    const rows = await db
      .select()
      .from(notes)
      .where(and(...conditions))
      .orderBy(desc(notes.isPinned), desc(notes.updatedAt))
      .limit(LIKE_SCAN_LIMIT);

    return (await hydrate(rows))
      .map((note) => ({
        note,
        score: Math.max(
          scoreText(query, note.titleSummary),
          scoreText(query, note.categoryTag) * 0.72,
          scoreText(query, bodyOf(note)) * 0.6,
        ),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.note.isPinned) - Number(a.note.isPinned) ||
          b.note.updatedAt - a.note.updatedAt,
      )
      .slice(0, limit);
  }

  /**
   * Relevance-ranked, unlike `listNotes`: a pinned note that barely matches
   * should not outrank the note the user is actually looking for, so pinning
   * only breaks ties here.
   */
  async function searchNotes(
    query: string,
    limit = 20,
    options: { includeArchived?: boolean } = {},
  ): Promise<NoteSearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const includeArchived = options.includeArchived ?? false;
    return ftsAvailable()
      ? searchWithFts(trimmed, limit, includeArchived)
      : searchWithLike(trimmed, limit, includeArchived);
  }

  /** Repopulates `notes_fts` from the notes themselves. Returns rows written. */
  async function rebuildSearchIndex(): Promise<number> {
    if (!ftsAvailable()) return 0;
    const all = await hydrate(await db.select().from(notes));
    return transact(async () => {
      client.execSync('DELETE FROM notes_fts');
      for (const note of all) writeFtsRow(note);
      return all.length;
    });
  }

  return {
    isFtsEnabled: ftsAvailable,
    getNote,
    listNotes,
    listTags,
    resolveNote,
    upsertNoteWithBullets,
    appendBullets,
    updateNote,
    deleteNote,
    softArchive,
    unarchiveNote,
    toggleBullet,
    updateBullet,
    removeBullet,
    reorderBullets,
    searchNotes,
    rebuildSearchIndex,
  };
}

export type NotesRepository = ReturnType<typeof createNotesRepository>;
