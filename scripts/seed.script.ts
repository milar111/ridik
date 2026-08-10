/**
 * Builds a realistic demo database and pushes it into the running simulators.
 *
 *   npm run seed
 *
 * It writes through the *real* repositories, so the resulting file is exactly
 * what the app would have produced had the user spoken every one of these
 * things — which makes it a genuine end-to-end check of the data layer, not a
 * hand-written fixture.
 *
 * Set RIDIK_SEED_PUSH=0 to build the file without installing it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { NodeSqliteClient } from '@/db/node-client';
import { createDrizzle, runMigrations } from '@/db/migrator';
import { createRepositories } from '@/repositories';
import { DateTime, setZoneOverride } from '@/core/time';
import { freezeClock } from '@/core/clock';

const ZONE = 'Europe/Sofia';
const BUNDLE_ID = 'ai.raisen.ridik';
const OUT = join(tmpdir(), 'ridik-seed');
const DB_PATH = join(OUT, 'ridik.db');

/** Wall clock -> epoch ms in the demo zone. */
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();

function iso(daysFromToday: number, time = '09:00'): string {
  return `${DateTime.now().setZone(ZONE).plus({ days: daysFromToday }).toISODate()}T${time}`;
}

describe('seed', () => {
  it('builds a demo database and pushes it to the simulators', async () => {
    setZoneOverride(ZONE);
    const restoreClock = freezeClock(Date.now());

    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });

    const client = new NodeSqliteClient(DB_PATH);
    const report = runMigrations(client);
    expect(report.to).toBeGreaterThan(0);
    const repos = createRepositories(createDrizzle(client));

    /* ---------------------------------------------------------- settings -- */
    await repos.settings.setMany({ timezone: ZONE, primaryCurrency: 'EUR', onboardingComplete: true });

    /* -------------------------------------------------------- curriculum -- */
    await repos.curriculum.replaceAll([
      { subject_name: 'Math', day_of_week: 1, start_time: '08:00', end_time: '09:30', location: 'Room 204' },
      { subject_name: 'Physics', day_of_week: 1, start_time: '10:00', end_time: '11:30', location: 'Lab B' },
      { subject_name: 'Math', day_of_week: 4, start_time: '10:00', end_time: '11:30', location: 'Room 204' },
      { subject_name: 'Robotics', day_of_week: 3, start_time: '14:00', end_time: '17:00', location: 'Maker lab' },
      { subject_name: 'Physics', day_of_week: 5, start_time: '09:00', end_time: '10:30', location: 'Lab B' },
    ]);

    /* ----------------------------------------------------------- people --- */
    await repos.crm.addCommitment({
      entityName: 'Ivo',
      commitmentText: 'Send the CAD files',
      dueDate: at(iso(1, '18:00')),
      direction: 'i_owe',
      relationshipContext: 'Robotics teammate',
    });
    await repos.crm.logInteraction({
      entityName: 'Ivo',
      summary: 'Met at the lab, went through the frame tolerances. Promised the CAD files.',
      occurredAt: at(iso(-1, '16:20')),
    });
    await repos.crm.addCommitment({
      entityName: 'Mira',
      commitmentText: 'Owes me the lab notebook back',
      dueDate: at(iso(3, '12:00')),
      direction: 'they_owe',
      relationshipContext: 'Physics partner',
    });

    /* --------------------------------------------------------- calendar --- */
    await repos.calendar.createEventWithBuffer(
      {
        title: 'Project meeting with Ivo',
        startsAt: at(iso(0, '15:00')),
        endsAt: at(iso(0, '16:00')),
        location: 'Maker lab',
        timezone: ZONE,
      },
      { bufferMinutes: 20 },
    );
    await repos.calendar.createEvent({
      title: 'Dentist',
      startsAt: at(iso(2, '11:00')),
      endsAt: at(iso(2, '11:45')),
      location: 'Vitosha 14',
      timezone: ZONE,
    });
    await repos.calendar.createEventWithBuffer(
      {
        title: 'Physics exam',
        startsAt: at(iso(5, '09:00')),
        endsAt: at(iso(5, '11:00')),
        location: 'Hall A',
        kind: 'exam',
        timezone: ZONE,
      },
      { bufferMinutes: 20 },
    );

    /* ------------------------------------------------------------ tasks --- */
    const chain = await repos.tasks.addDependencyByTitles({
      childTitle: 'Assemble hardware build',
      parentTitles: ['3D print frame', 'Order servos'],
      childDue: at(iso(7, '18:00')),
    });
    expect(chain.ok).toBe(true);

    await repos.tasks.createTask({
      title: 'Physics homework, page 42 exercises',
      dueDate: at(iso(1, '20:00')),
      estimatedMinutes: 90,
      priority: 1,
    });
    await repos.tasks.createTask({ title: 'Email the supervisor', dueDate: at(iso(0, '17:00')) });
    await repos.tasks.createTask({ title: 'Renew the library card', dueDate: at(iso(-2, '12:00')) });
    await repos.tasks.createTask({ title: 'Read the I2C datasheet' });

    /* --------------------------------------------------------- projects --- */
    const trip = await repos.projects.createProject({
      name: 'Japan trip',
      kind: 'trip',
      emoji: '🗻',
      description: 'Two weeks in October',
      targetDate: at(iso(60, '09:00')),
      sections: ['Luggage', 'Places to visit', 'Budget'],
    });
    await repos.projects.addItems(trip.id, [
      { content: 'Slippers', kind: 'todo', isCheckbox: true, sectionTitle: 'Luggage' },
      { content: 'Universal adapter', kind: 'todo', isCheckbox: true, sectionTitle: 'Luggage' },
      { content: 'Rail pass printout', kind: 'todo', isCheckbox: true, sectionTitle: 'Luggage' },
      { content: 'Fushimi Inari at sunrise', kind: 'idea', sectionTitle: 'Places to visit' },
      { content: 'Akihabara parts shops', kind: 'idea', sectionTitle: 'Places to visit' },
      { content: 'Budget roughly 40k JPY for transit', kind: 'note', sectionTitle: 'Budget' },
    ]);

    const robot = await repos.projects.createProject({
      name: 'Robotics build',
      kind: 'project',
      emoji: '🤖',
      description: 'Line-following chassis for the spring contest',
      sections: ['Hardware', 'Firmware'],
    });
    await repos.projects.addItems(robot.id, [
      { content: 'Use M3 heat-set inserts instead of M2', kind: 'idea', sectionTitle: 'Hardware' },
      { content: 'Reprint the frame at 40% infill', kind: 'todo', isCheckbox: true, sectionTitle: 'Hardware' },
      { content: 'Could we run the encoders off the second I2C bus?', kind: 'question', sectionTitle: 'Firmware' },
      { content: 'PID tuning pass', kind: 'milestone', sectionTitle: 'Firmware' },
    ]);

    /* ------------------------------------------------------------ notes --- */
    await repos.notes.upsertNoteWithBullets({
      titleSummary: 'Robotics chassis',
      categoryTag: 'Hardware',
      bullets: [
        'Use M3 screws instead of M2 — the M2 heads strip under load',
        'Frame needs 10k resistors for the pull-ups',
        'Servo horns arrive Thursday',
      ],
      projectId: robot.id,
    });
    await repos.notes.upsertNoteWithBullets({
      titleSummary: 'I2C debugging',
      categoryTag: 'Firmware',
      bullets: [
        'Bus lock-up traced to a missing pull-up on SDA',
        'Scope showed the clock stretching past 100us',
        'Fixed with 4.7k on both lines',
      ],
    });
    await repos.notes.upsertNoteWithBullets({
      titleSummary: 'Physics revision plan',
      categoryTag: 'School',
      bullets: ['Thermodynamics chapter 4', 'Redo the 2023 past paper', 'Ask about entropy question 7'],
    });

    /* ------------------------------------------------------- checklists --- */
    await repos.checklists.addItems('Hardware', [
      { text: '10k resistors', quantity: '20' },
      { text: 'M3 heat-set inserts', quantity: '50' },
      { text: 'PLA filament, black', quantity: '1kg' },
      'Servo horns',
    ]);
    await repos.checklists.addItems('Groceries', ['Milk', 'Coffee beans', 'Bread', 'Olive oil']);
    await repos.checklists.toggle({ listName: 'Groceries', itemQuery: 'Bread', completed: true });

    /* ----------------------------------------------------------- ledger --- */
    const spend: [number, string, string, string | undefined][] = [
      [12, 'EUR', 'Hardware', '3D printer filament'],
      [34.5, 'EUR', 'Hardware', 'Servo motors'],
      [15, 'EUR', 'Food', 'Lunch with Ivo'],
      [8.2, 'EUR', 'Transport', 'Metro card top-up'],
      [62, 'EUR', 'Hardware', 'Oscilloscope probes'],
      [4.6, 'EUR', 'Food', 'Coffee'],
      [120, 'EUR', 'Education', 'Physics tutoring'],
    ];
    for (const [amount, currency, category, description] of spend) {
      await repos.ledger.addTransaction({
        amount,
        currency,
        category,
        description,
        direction: 'expense',
        entityName: description?.includes('Ivo') ? 'Ivo' : undefined,
      });
    }
    await repos.ledger.addTransaction({
      amount: 200,
      currency: 'EUR',
      category: 'Allowance',
      direction: 'income',
      description: 'Monthly allowance',
    });

    /* ----------------------------------------------------------- habits --- */
    for (const [name, unit] of [
      ['Study', 'minutes'],
      ['Workout', 'minutes'],
      ['Reading', 'session'],
    ] as const) {
      await repos.habits.getOrCreateHabit(name, { unit });
    }
    // A four-day study streak ending today, matching the briefing example.
    for (let d = 3; d >= 0; d--) {
      await repos.habits.logHabit({
        habitName: 'Study',
        durationMinutes: 45 + d * 5,
        onDate: DateTime.now().setZone(ZONE).minus({ days: d }).toISODate()!,
      });
    }
    await repos.habits.logHabit({ habitName: 'Workout', durationMinutes: 45, onDate: DateTime.now().setZone(ZONE).minus({ days: 1 }).toISODate()! });

    /* --------------------------------------------------------- activity --- */
    await repos.activity.log({
      description: 'Spent two hours debugging the I2C sensors and finally got them working',
      durationMinutes: 120,
      projectId: robot.id,
      at: at(iso(-1, '20:30')),
    });
    await repos.activity.log({
      description: 'Reprinted the chassis frame, third time is the charm',
      durationMinutes: 75,
      projectId: robot.id,
      at: at(iso(-2, '17:00')),
    });
    await repos.activity.log({ description: 'Drafted the Physics revision plan', durationMinutes: 30, at: at(iso(-3, '19:00')) });

    /* ----------------------------------------------------------- places --- */
    const lab = await repos.places.upsertPlace({
      label: 'The lab',
      latitude: 42.6501,
      longitude: 23.3792,
      radiusMeters: 120,
      address: 'Technical University, Sofia',
    });
    await repos.places.upsertPlace({ label: 'Home', latitude: 42.6977, longitude: 23.3219, radiusMeters: 150 });
    await repos.geofences.createTrigger({
      label: 'The lab',
      actionDescription: 'Grab your flash drive',
      triggerType: 'ENTER',
      latitude: lab.latitude,
      longitude: lab.longitude,
      radiusMeters: lab.radiusMeters,
      placeId: lab.id,
      oneShot: true,
    });

    const counts = client.getFirstSync<Record<string, number>>(
      `SELECT
         (SELECT COUNT(*) FROM tasks) AS tasks,
         (SELECT COUNT(*) FROM notes) AS notes,
         (SELECT COUNT(*) FROM projects) AS projects,
         (SELECT COUNT(*) FROM project_items) AS items,
         (SELECT COUNT(*) FROM calendar_events) AS events,
         (SELECT COUNT(*) FROM transactions) AS tx,
         (SELECT COUNT(*) FROM checklists) AS checklist,
         (SELECT COUNT(*) FROM crm_commitments) AS commitments`,
      [],
    );
    client.closeSync();

    // eslint-disable-next-line no-console
    console.log('seeded', DB_PATH, counts);
    expect(counts?.tasks).toBeGreaterThan(0);

    if (process.env.RIDIK_SEED_PUSH === '0') return;
    pushToSimulators();
    restoreClock();
  });
});

/** Copies the seeded file into whichever simulators are currently running. */
function pushToSimulators(): void {
  // iOS: the app's sandbox path is only knowable through simctl.
  try {
    const container = execFileSync('xcrun', ['simctl', 'get_app_container', 'booted', BUNDLE_ID, 'data'], {
      encoding: 'utf8',
    }).trim();
    const target = join(container, 'Documents', 'SQLite');
    mkdirSync(target, { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      const src = `${DB_PATH}${suffix}`;
      if (existsSync(src)) execFileSync('cp', [src, join(target, `ridik.db${suffix}`)]);
      else execFileSync('rm', ['-f', join(target, `ridik.db${suffix}`)]);
    }
    // eslint-disable-next-line no-console
    console.log('pushed to iOS simulator:', target);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.log('iOS push skipped:', error instanceof Error ? error.message.split('\n')[0] : error);
  }

  // Android: run-as reaches the debuggable app's private data directory.
  try {
    const adb = join(process.env.HOME ?? '', 'Library/Android/sdk/platform-tools/adb');
    execFileSync(adb, ['shell', 'run-as', BUNDLE_ID, 'mkdir', '-p', 'files/SQLite']);
    for (const suffix of ['', '-wal', '-shm']) {
      const src = `${DB_PATH}${suffix}`;
      const remoteTmp = `/data/local/tmp/ridik.db${suffix}`;
      if (!existsSync(src)) {
        execFileSync(adb, ['shell', 'run-as', BUNDLE_ID, 'rm', '-f', `files/SQLite/ridik.db${suffix}`]);
        continue;
      }
      execFileSync(adb, ['push', src, remoteTmp]);
      execFileSync(adb, [
        'shell',
        `run-as ${BUNDLE_ID} sh -c 'cat ${remoteTmp} > files/SQLite/ridik.db${suffix}'`,
      ]);
      execFileSync(adb, ['shell', 'rm', '-f', remoteTmp]);
    }
    // eslint-disable-next-line no-console
    console.log('pushed to Android emulator');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.log('Android push skipped:', error instanceof Error ? error.message.split('\n')[0] : error);
  }
}
