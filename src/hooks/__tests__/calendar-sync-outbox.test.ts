/**
 * Every calendar write reaches the outbox, not just the assistant's.
 *
 * The bug this exists for was invisible rather than broken. `src/llm/executor.ts`
 * has enqueued a sync entry beside every calendar write since sync was built,
 * so an event the user *spoke* reached Google and the phone's own calendar —
 * while the identical event created, edited or deleted on the calendar screen
 * changed nothing anywhere but SQLite. Deleting was the loudest case: the event
 * vanished from Ridik and stayed in Google for ever.
 *
 * Two tests, doing two different jobs. The first reads the source, so a *new*
 * write hook added later cannot quietly skip the queue the way these four did.
 * The second is the one that would have caught the original: a hard delete has
 * to carry its remote ids, and by the time the worker looks, the row is gone.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(__dirname, '..', 'useCalendar.ts'), 'utf8');

/**
 * The hooks that write an event. Kept as a literal list *and* checked against
 * the file, so adding a fifth writer without adding it here fails rather than
 * passing by omission — a list that only holds what it already knows about is
 * an allow-list, not a test.
 */
const WRITERS = [
  'useCreateEvent',
  'useCreateEventWithBuffer',
  'useUpdateEvent',
  'useDeleteEvent',
];

/** The body of one exported hook, from its signature to the next one. */
function bodyOf(name: string): string {
  const start = SOURCE.indexOf(`export function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = SOURCE.indexOf('\nexport ', start + 1);
  return SOURCE.slice(start, next === -1 ? undefined : next);
}

describe('the calendar sync outbox', () => {
  it.each(WRITERS)('%s queues the change for syncing', (name) => {
    expect(bodyOf(name)).toContain('queueSync(');
  });

  /*
    The other direction: a writer that exists in the file but not in the list
    above would never be checked by the test that matters. This is what makes
    WRITERS a description of the file rather than a wish about it.
  */
  it('knows about every write hook in the file', () => {
    const declared = [...SOURCE.matchAll(/export function (use\w+)\(/g)].map((m) => m[1]!);
    const writers = declared.filter((name) => {
      const body = bodyOf(name);
      return (
        body.includes('calendar.createEvent') ||
        body.includes('calendar.createEventWithBuffer') ||
        body.includes('calendar.updateEvent') ||
        body.includes('calendar.hardDelete') ||
        body.includes('calendar.softDelete')
      );
    });
    expect(writers.sort()).toEqual([...WRITERS].sort());
  });

  /*
    The specific shape that made the original bug survive a fix attempt.
    `enqueueEventSync` in the service takes an id and re-reads the row, which is
    fine for a soft delete and useless for a hard one — the row is already gone,
    so all three remote ids come back null and there is nothing left to retract.
    The hook has to copy them off the row the mutation returned.
  */
  it('takes the row rather than the id, so a hard delete keeps its remote ids', () => {
    const queue = SOURCE.slice(SOURCE.indexOf('async function queueSync'));
    expect(queue).toContain('event.googleEventId');
    expect(queue).toContain('event.nativeEventId');
    expect(SOURCE).not.toMatch(/enqueueEventSync\(/);
  });

  /*
    A travel block is a separate row with its own copy in Google, so it has to
    be retracted separately — and it has to be read *before* the delete, which
    removes it from the query that would have found it.
  */
  it('takes any travel block with the event it belongs to', () => {
    const body = bodyOf('useDeleteEvent');
    expect(body.indexOf('listBuffersFor')).toBeLessThan(body.indexOf('hardDelete'));
    expect(body).toContain("queueSync(buffer, 'delete')");
  });

  /*
    Syncing is never allowed to fail the write. The row is in SQLite either way
    and the queue is durable, so a screen that reported "could not save" over a
    saved event would be the wrong lie in the more alarming direction.
  */
  it('never lets a sync failure surface as a failed save', () => {
    expect(SOURCE.slice(SOURCE.indexOf('async function queueSync'))).toMatch(
      /try \{[\s\S]*?\} catch \{/,
    );
  });
});
