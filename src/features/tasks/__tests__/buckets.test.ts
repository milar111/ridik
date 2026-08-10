import { bucketOf, BUCKET_ORDER, groupByDueBucket } from '../buckets';
import { localToEpoch } from '@/core/time';
import type { Task } from '@/db/schema';

const NOW = localToEpoch('2026-03-10T14:00');

function task(id: string, dueDate: number | null, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    dueDate,
    isCompleted: false,
    isLocked: false,
    createdAt: 0,
    notes: null,
    projectId: null,
    priority: 2,
    estimatedMinutes: null,
    completedAt: null,
    unlockedAt: null,
    calendarEventId: null,
    source: 'voice',
    updatedAt: 0,
    ...extra,
  };
}

describe('due buckets', () => {
  it('buckets by calendar day, not by elapsed hours', () => {
    // 22:00 today is eight hours away; 09:00 tomorrow is nineteen. Only the
    // calendar day decides which bucket each lands in.
    expect(bucketOf(localToEpoch('2026-03-10T22:00'), NOW)).toBe('today');
    expect(bucketOf(localToEpoch('2026-03-11T09:00'), NOW)).toBe('tomorrow');
  });

  it('separates overdue, this week, later and undated', () => {
    expect(bucketOf(localToEpoch('2026-03-09T23:59'), NOW)).toBe('overdue');
    expect(bucketOf(localToEpoch('2026-03-15T09:00'), NOW)).toBe('week');
    expect(bucketOf(localToEpoch('2026-03-17T09:00'), NOW)).toBe('week');
    expect(bucketOf(localToEpoch('2026-03-18T09:00'), NOW)).toBe('later');
    expect(bucketOf(null, NOW)).toBe('none');
  });

  it('groups in urgency order, drops empty buckets and keeps input order', () => {
    const groups = groupByDueBucket(
      [
        task('later', localToEpoch('2026-04-01T09:00')),
        task('overdue-a', localToEpoch('2026-03-01T09:00')),
        task('undated', null),
        task('overdue-b', localToEpoch('2026-03-05T09:00')),
      ],
      NOW,
    );

    expect(groups.map((g) => g.bucket)).toEqual(['overdue', 'later', 'none']);
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual(['overdue-a', 'overdue-b']);
    // Every bucket the grouper can emit has a place in the fixed order.
    for (const group of groups) expect(BUCKET_ORDER).toContain(group.bucket);
  });
});
