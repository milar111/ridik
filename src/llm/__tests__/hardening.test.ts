/**
 * Regressions for gaps the adversarial review surfaced but could not close
 * inside a single module: detail dropped on a dependency-carrying task, a move
 * that booked over an occupied slot in silence, and a task left orphaned when
 * the commitment it belongs to fails to write.
 */
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createRepositories, type Repositories } from '@/repositories';
import { crmCommitments, tasks as tasksTable } from '@/db/schema';
import { freezeClock } from '@/core/clock';
import { setZoneOverride, localToEpoch } from '@/core/time';
import { createExecutor } from '@/llm/executor';
import type { LlmAction } from '@/llm/contract';

const ZONE = 'Europe/Sofia';
const NOW = localToEpoch('2026-08-11T09:00', ZONE);

describe('executor hardening', () => {
  let t: TestDatabase;
  let repos: Repositories;
  let restoreClock: () => void;

  beforeEach(() => {
    setZoneOverride(ZONE);
    restoreClock = freezeClock(NOW);
    t = createTestDatabase();
    repos = createRepositories(t.db);
  });

  afterEach(() => {
    restoreClock();
    setZoneOverride(null);
    t.close();
  });

  const run = (action: LlmAction, options?: { confirmed?: boolean }) =>
    createExecutor({ repos, zone: ZONE, now: NOW , confirmMode: 'never' }).execute(action, options);

  it('keeps notes, priority and estimate on a task that also has prerequisites', async () => {
    const result = await run({
      tool_name: 'task_add',
      parameters: {
        title: 'Assemble hardware build',
        notes: 'Torque the M3s to 0.4 Nm',
        priority: 1,
        estimated_minutes: 180,
        depends_on: ['3D print frame', 'Order servos'],
        due: '2026-08-14T18:00',
      },
    } as LlmAction);

    expect(result.ok).toBe(true);
    const rows = await t.db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.title, 'Assemble hardware build'));
    const child = rows[0]!;
    expect(child.notes).toBe('Torque the M3s to 0.4 Nm');
    expect(child.priority).toBe(1);
    expect(child.estimatedMinutes).toBe(180);
    // The prerequisites must still have locked it.
    expect(child.isLocked).toBe(true);
  });

  it('asks before moving an event onto an occupied slot, and moves nothing', async () => {
    const dentist = await repos.calendar.createEvent({
      title: 'Dentist',
      startsAt: localToEpoch('2026-08-12T11:00', ZONE),
      endsAt: localToEpoch('2026-08-12T11:45', ZONE),
      timezone: ZONE,
    });
    await repos.calendar.createEvent({
      title: 'Standup',
      startsAt: localToEpoch('2026-08-12T15:00', ZONE),
      endsAt: localToEpoch('2026-08-12T15:30', ZONE),
      timezone: ZONE,
    });

    const asked = await run({
      tool_name: 'calendar_update',
      parameters: { target: { query: 'dentist' }, start: '2026-08-12T15:00' },
    } as LlmAction);

    expect(asked.needsConfirmation).toBeDefined();
    expect(asked.needsConfirmation?.question).toContain('Standup');
    const unmoved = await repos.calendar.getById(dentist.id);
    expect(unmoved?.startsAt).toBe(localToEpoch('2026-08-12T11:00', ZONE));

    const confirmed = await run(
      {
        tool_name: 'calendar_update',
        parameters: { target: { query: 'dentist' }, start: '2026-08-12T15:00' },
      } as LlmAction,
      { confirmed: true },
    );
    expect(confirmed.ok).toBe(true);
    const moved = await repos.calendar.getById(dentist.id);
    expect(moved?.startsAt).toBe(localToEpoch('2026-08-12T15:00', ZONE));
    // The length the user already agreed to is preserved.
    expect(moved!.endsAt - moved!.startsAt).toBe(45 * 60_000);
  });

  it('does not leave a task behind when the commitment cannot be written', async () => {
    const before = await t.db.select().from(tasksTable);

    const broken = createExecutor({
      repos: {
        ...repos,
        crm: {
          ...repos.crm,
          addCommitment: async () => {
            throw new Error('disk full');
          },
        },
      } as Repositories,
      zone: ZONE,
      now: NOW,
    });

    const result = await broken.execute({
      tool_name: 'crm_add_commitment',
      parameters: {
        entity_name: 'Ivo',
        commitment_text: 'Send the CAD files',
        direction: 'i_owe',
        create_task: true,
      },
    } as LlmAction);

    expect(result.ok).toBe(false);
    const after = await t.db.select().from(tasksTable);
    expect(after).toHaveLength(before.length);
  });

  it('honours a briefing the user asked for on screen rather than out loud', async () => {
    const spoken = await run({
      tool_name: 'briefing_generate',
      parameters: { scope: 'today', speak: true },
    } as LlmAction);
    expect(spoken.silent).toBeFalsy();
    expect(spoken.summary.length).toBeGreaterThan(0);

    const quiet = await run({
      tool_name: 'briefing_generate',
      parameters: { scope: 'today', speak: false },
    } as LlmAction);
    // Still returns the text — the dock shows it, TTS skips it.
    expect(quiet.silent).toBe(true);
    expect(quiet.summary).toBe(spoken.summary);
  });

  it('links the commitment to the task it created', async () => {
    const result = await run({
      tool_name: 'crm_add_commitment',
      parameters: {
        entity_name: 'Ivo',
        commitment_text: 'Send the CAD files',
        direction: 'i_owe',
        create_task: true,
      },
    } as LlmAction);

    expect(result.ok).toBe(true);
    const [commitment] = await t.db.select().from(crmCommitments);
    expect(commitment?.taskId).toBeTruthy();
    const linked = await repos.tasks.getTask(commitment!.taskId!);
    expect(linked?.title).toBe('Send the CAD files');
  });
});
