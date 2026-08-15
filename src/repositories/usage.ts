/**
 * Has the user ever used each part of the app?
 *
 * One question, asked because "you have done all your habits" and "you have
 * never added a habit" are the same picture without it — and that single
 * missing distinction is most of the reason an untouched install's home-screen
 * widgets look broken rather than empty.
 *
 * Counts and not rows. The caller never wants the data, only whether there is
 * any, and this runs on every widget publish — which is every data change.
 * `count(*)` over an indexed table is a fraction of the cost of fetching a list
 * to call `.length` on it, and it does not grow with the user's history.
 *
 * "Ever used" deliberately ignores what is due, scheduled or archived. A user
 * whose only tasks are all finished has still used tasks; telling them "no
 * tasks yet" would be a lie that invites them to set up what they already have.
 */
import { sql } from 'drizzle-orm';

import type { RidikDatabase } from '@/db/migrator';
import { calendarEvents, checklists, habits, tasks } from '@/db/schema';

export type UsageCounts = {
  events: number;
  tasks: number;
  habits: number;
  lists: number;
};

export function createUsageRepository(db: RidikDatabase) {
  async function counts(): Promise<UsageCounts> {
    // One statement rather than four round trips: SQLite answers all of these
    // from indexes, and the publisher is on the path of every write.
    const [row] = await db
      .select({
        events: sql<number>`(select count(*) from ${calendarEvents} where ${calendarEvents.deletedAt} is null)`,
        tasks: sql<number>`(select count(*) from ${tasks})`,
        habits: sql<number>`(select count(*) from ${habits})`,
        lists: sql<number>`(select count(distinct ${checklists.listName}) from ${checklists})`,
      })
      .from(sql`(select 1)`);

    return {
      events: Number(row?.events ?? 0),
      tasks: Number(row?.tasks ?? 0),
      habits: Number(row?.habits ?? 0),
      lists: Number(row?.lists ?? 0),
    };
  }

  return { counts };
}

export type UsageRepository = ReturnType<typeof createUsageRepository>;
