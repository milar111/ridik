import { freezeClock } from '@/core/clock';
import { localToEpoch, setZoneOverride } from '@/core/time';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createCrmRepository, parseAliases, type CrmRepository } from '@/repositories/crm';
import { createLedgerRepository, type LedgerRepository } from '@/repositories/ledger';
import { createTasksRepository, type TasksRepository } from '@/repositories/tasks';

const SOFIA = 'Europe/Sofia';
const NOW = localToEpoch('2026-03-15T12:00', SOFIA);
const day = (local: string) => localToEpoch(local, SOFIA);

describe('crm repository', () => {
  let t: TestDatabase;
  let crm: CrmRepository;
  let ledger: LedgerRepository;
  let tasks: TasksRepository;
  let restoreClock: () => void;

  beforeEach(() => {
    t = createTestDatabase();
    crm = createCrmRepository(t.db);
    ledger = createLedgerRepository(t.db);
    tasks = createTasksRepository(t.db);
    restoreClock = freezeClock(NOW);
    setZoneOverride(SOFIA);
  });

  afterEach(() => {
    restoreClock();
    setZoneOverride(null);
    t.close();
  });

  it('reuses a contact regardless of casing and fills missing context once', async () => {
    const first = await crm.getOrCreateEntity('Ivan Petrov');
    const again = await crm.getOrCreateEntity('  ivan petrov  ', {
      relationshipContext: 'physics tutor',
    });

    expect(again.id).toBe(first.id);
    expect(again.relationshipContext).toBe('physics tutor');
    expect(await crm.listEntities()).toHaveLength(1);

    const third = await crm.getOrCreateEntity('IVAN PETROV', { relationshipContext: 'neighbour' });
    // Context the user already curated is never overwritten by a later guess.
    expect(third.relationshipContext).toBe('physics tutor');
  });

  it('rejects an empty name', async () => {
    await expect(crm.getOrCreateEntity('   ')).rejects.toThrow(/name/);
  });

  it('resolves a contact through its aliases', async () => {
    const ivan = await crm.getOrCreateEntity('Ivan Petrov');
    const aliased = await crm.addAlias(ivan.id, 'Vanya');
    expect(aliased.ok).toBe(true);

    const byAlias = await crm.getOrCreateEntity('vanya');
    expect(byAlias.id).toBe(ivan.id);
    expect(await crm.listEntities()).toHaveLength(1);

    const resolved = await crm.resolveEntity('Vanya');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value.id).toBe(ivan.id);

    // Adding the same alias twice is a no-op rather than a duplicate.
    await crm.addAlias(ivan.id, 'vanya');
    const profile = await crm.getEntityProfile(ivan.id);
    if (!profile.ok) throw profile.error;
    expect(profile.value.aliases).toEqual(['Vanya']);

    const missing = await crm.addAlias('nope', 'Whoever');
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected a failure');
    expect(missing.error.code).toBe('not_found');
  });

  it('resolves fuzzily, and asks rather than guesses when it is close', async () => {
    await crm.getOrCreateEntity('Ivan Petrov');
    await crm.getOrCreateEntity('Maria Ivanova');

    const typo = await crm.resolveEntity('Ivan Petrof');
    expect(typo.ok).toBe(true);
    if (!typo.ok) throw typo.error;
    expect(typo.value.name).toBe('Ivan Petrov');

    const unknown = await crm.resolveEntity('Genghis Khan');
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error('expected a failure');
    expect(unknown.error.code).toBe('not_found');

    await crm.getOrCreateEntity('Ivan Petrova');
    const ambiguous = await crm.resolveEntity('Ivan Petro');
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) throw new Error('expected a failure');
    expect(ambiguous.error.code).toBe('ambiguous');
  });

  it('creates the contact on demand when a commitment is recorded', async () => {
    const { entity, commitment } = await crm.addCommitment({
      entityName: 'Dr Georgiev',
      commitmentText: 'send the lab report',
      dueDate: day('2026-03-20T09:00'),
      direction: 'i_owe',
      relationshipContext: 'supervisor',
    });

    expect(entity.name).toBe('Dr Georgiev');
    expect(entity.relationshipContext).toBe('supervisor');
    expect(commitment.entityId).toBe(entity.id);
    expect(commitment.isCompleted).toBe(false);
    expect(commitment.completedAt).toBeNull();
    expect(commitment.createdAt).toBe(NOW);

    const second = await crm.addCommitment({
      entityName: 'dr georgiev',
      commitmentText: 'book a slot',
      direction: 'they_owe',
    });
    expect(second.entity.id).toBe(entity.id);
    expect(await crm.listCommitmentsFor(entity.id)).toHaveLength(2);
  });

  it('does not leave a bare contact behind when the commitment cannot be written', async () => {
    // Blank text is refused before anything at all is written.
    await expect(
      crm.addCommitment({ entityName: 'Ghost', commitmentText: '   ' }),
    ).rejects.toThrow(/commitment/);
    expect(await crm.listEntities()).toEqual([]);

    // The case that actually needs the transaction: the contact row is already
    // in the database by the time the commitment insert fails.
    t.client.execSync(
      `CREATE TRIGGER reject_commitments BEFORE INSERT ON crm_commitments
       BEGIN SELECT RAISE(ABORT, 'disk full'); END;`,
    );
    await expect(
      crm.addCommitment({ entityName: 'Ghost', commitmentText: 'send the lab report' }),
    ).rejects.toThrow(/disk full/);
    expect(await crm.listEntities()).toEqual([]);

    // ...and the connection is usable afterwards, not stuck mid-transaction.
    t.client.execSync('DROP TRIGGER reject_commitments');
    const recovered = await crm.addCommitment({
      entityName: 'Ghost',
      commitmentText: 'send the lab report',
    });
    expect(recovered.entity.name).toBe('Ghost');
    expect(await crm.listCommitmentsFor(recovered.entity.id)).toHaveLength(1);
  });

  it('rolls back a half-written interaction too', async () => {
    t.client.execSync(
      `CREATE TRIGGER reject_interactions BEFORE INSERT ON crm_interactions
       BEGIN SELECT RAISE(ABORT, 'disk full'); END;`,
    );
    await expect(
      crm.logInteraction({ entityName: 'Ghost', summary: 'coffee and a chat' }),
    ).rejects.toThrow(/disk full/);
    expect(await crm.listEntities()).toEqual([]);
  });

  it('records the interaction that produced a commitment in the same transaction', async () => {
    const { entity, commitment, interaction } = await crm.addCommitment({
      entityName: 'Dr Georgiev',
      commitmentText: 'send the CAD files',
      interactionSummary: 'Promised to send the CAD files by Friday.',
    });

    expect(interaction?.summary).toBe('Promised to send the CAD files by Friday.');
    expect(interaction?.entityId).toBe(entity.id);
    expect(interaction?.occurredAt).toBe(NOW);

    const profile = await crm.getEntityProfile(entity.id);
    if (!profile.ok) throw profile.error;
    expect(profile.value.interactions.map((i) => i.summary)).toEqual([
      'Promised to send the CAD files by Friday.',
    ]);
    expect(profile.value.openCommitments.map((c) => c.id)).toEqual([commitment.id]);

    // Nothing is logged when the model does not supply one.
    const bare = await crm.addCommitment({ entityName: 'Dr Georgiev', commitmentText: 'book a slot' });
    expect(bare.interaction).toBeUndefined();
    const after = await crm.getEntityProfile(entity.id);
    if (!after.ok) throw after.error;
    expect(after.value.interactions).toHaveLength(1);
  });

  it('completes and re-opens a commitment', async () => {
    const { commitment } = await crm.addCommitment({
      entityName: 'Ivan',
      commitmentText: 'return the drill',
    });

    const done = await crm.completeCommitment(commitment.id);
    expect(done.ok).toBe(true);
    if (!done.ok) throw done.error;
    expect(done.value.isCompleted).toBe(true);
    expect(done.value.completedAt).toBe(NOW);
    expect(await crm.listOpenCommitments()).toEqual([]);

    const reopened = await crm.completeCommitment(commitment.id, false);
    if (!reopened.ok) throw reopened.error;
    expect(reopened.value.isCompleted).toBe(false);
    expect(reopened.value.completedAt).toBeNull();
    expect(await crm.listOpenCommitments()).toHaveLength(1);

    const missing = await crm.completeCommitment('nope');
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected a failure');
    expect(missing.error.code).toBe('not_found');
  });

  it('lists open commitments by urgency, undated last', async () => {
    await crm.addCommitment({
      entityName: 'Ivan',
      commitmentText: 'later',
      dueDate: day('2026-03-25T09:00'),
    });
    await crm.addCommitment({ entityName: 'Maria', commitmentText: 'someday' });
    await crm.addCommitment({
      entityName: 'Ivan',
      commitmentText: 'sooner',
      dueDate: day('2026-03-16T09:00'),
    });
    const finished = await crm.addCommitment({
      entityName: 'Maria',
      commitmentText: 'already done',
      dueDate: day('2026-03-14T09:00'),
    });
    await crm.completeCommitment(finished.commitment.id);

    const open = await crm.listOpenCommitments();
    expect(open.map((o) => o.commitment.commitmentText)).toEqual(['sooner', 'later', 'someday']);
    expect(open[0]!.entity.name).toBe('Ivan');

    // An undated promise is not overdue, so `dueBefore` leaves it out.
    const soon = await crm.listOpenCommitments({ dueBefore: day('2026-03-20T00:00') });
    expect(soon.map((o) => o.commitment.commitmentText)).toEqual(['sooner']);
  });

  it('lists a contact’s commitments with the open ones first', async () => {
    const { entity } = await crm.addCommitment({
      entityName: 'Ivan',
      commitmentText: 'first',
      dueDate: day('2026-03-16T09:00'),
    });
    const second = await crm.addCommitment({
      entityName: 'Ivan',
      commitmentText: 'second',
      dueDate: day('2026-03-17T09:00'),
    });
    await crm.completeCommitment(second.commitment.id);

    const all = await crm.listCommitmentsFor(entity.id);
    expect(all.map((c) => c.commitmentText)).toEqual(['first', 'second']);
    expect(all[0]!.isCompleted).toBe(false);
  });

  it('logs interactions with an explicit or implicit timestamp', async () => {
    const first = await crm.logInteraction({
      entityName: 'Ivan',
      summary: 'coffee, talked about the robot',
      relationshipContext: 'friend',
    });
    expect(first.interaction.occurredAt).toBe(NOW);
    expect(first.entity.relationshipContext).toBe('friend');

    const second = await crm.logInteraction({
      entityName: 'ivan',
      summary: 'lent him the drill',
      occurredAt: day('2026-03-10T18:00'),
    });
    expect(second.entity.id).toBe(first.entity.id);
    expect(second.interaction.occurredAt).toBe(day('2026-03-10T18:00'));
  });

  it('assembles a full profile: interactions, commitments and money', async () => {
    const ivan = await crm.getOrCreateEntity('Ivan Petrov', { relationshipContext: 'flatmate' });
    await crm.addAlias(ivan.id, 'Vanya');

    await crm.logInteraction({
      entityName: 'Ivan Petrov',
      summary: 'older chat',
      occurredAt: day('2026-03-01T10:00'),
    });
    await crm.logInteraction({
      entityName: 'Vanya',
      summary: 'newer chat',
      occurredAt: day('2026-03-12T10:00'),
    });

    const open = await crm.addCommitment({
      entityName: 'Ivan Petrov',
      commitmentText: 'return the drill',
      direction: 'i_owe',
    });
    const closed = await crm.addCommitment({
      entityName: 'Ivan Petrov',
      commitmentText: 'lend him the charger',
      direction: 'they_owe',
    });
    await crm.completeCommitment(closed.commitment.id);

    // Matched case-insensitively on the name and on every alias.
    await ledger.addTransaction({
      amount: 40,
      currency: 'EUR',
      category: 'Rent',
      entityName: 'ivan petrov',
      direction: 'expense',
    });
    await ledger.addTransaction({
      amount: 100,
      currency: 'EUR',
      category: 'Rent',
      entityName: 'Vanya',
      direction: 'income',
    });
    await ledger.addTransaction({
      amount: 25,
      currency: 'USD',
      category: 'Concert',
      entityName: 'VANYA',
      direction: 'expense',
    });
    await ledger.addTransaction({ amount: 999, category: 'Rent', entityName: 'Someone Else' });

    const result = await crm.getEntityProfile(ivan.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    const profile = result.value;

    expect(profile.entity.relationshipContext).toBe('flatmate');
    expect(profile.aliases).toEqual(['Vanya']);
    expect(profile.interactions.map((i) => i.summary)).toEqual(['newer chat', 'older chat']);
    expect(profile.lastInteractionAt).toBe(day('2026-03-12T10:00'));
    expect(profile.openCommitments.map((c) => c.commitmentText)).toEqual([open.commitment.commitmentText]);
    expect(profile.completedCommitments.map((c) => c.commitmentText)).toEqual(['lend him the charger']);

    expect(profile.transactions).toHaveLength(3);
    expect(profile.spentByCurrency).toEqual({ EUR: 40, USD: 25 });
    expect(profile.receivedByCurrency).toEqual({ EUR: 100 });
    // Currencies stay apart: 60 EUR up, 25 USD down.
    expect(profile.netByCurrency).toEqual({ EUR: 60, USD: -25 });
  });

  it('reports a missing profile instead of throwing', async () => {
    const result = await crm.getEntityProfile('nope');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error.code).toBe('not_found');
  });

  it('lists contacts by most recent contact, with open commitment counts', async () => {
    await crm.getOrCreateEntity('Never Contacted');

    await crm.logInteraction({
      entityName: 'Old Friend',
      summary: 'a while ago',
      occurredAt: day('2026-01-05T10:00'),
    });
    await crm.logInteraction({
      entityName: 'Recent Friend',
      summary: 'yesterday',
      occurredAt: day('2026-03-14T10:00'),
    });

    const commitments = await crm.addCommitment({
      entityName: 'Old Friend',
      commitmentText: 'still owe him a book',
    });
    const done = await crm.addCommitment({
      entityName: 'Old Friend',
      commitmentText: 'paid back',
    });
    await crm.completeCommitment(done.commitment.id);

    const listed = await crm.listEntities();
    expect(listed.map((e) => e.entity.name)).toEqual([
      'Recent Friend',
      'Old Friend',
      'Never Contacted',
    ]);
    expect(listed[1]).toMatchObject({ openCommitments: 1, interactionCount: 1 });
    expect(listed[1]!.lastInteractionAt).toBe(day('2026-01-05T10:00'));
    expect(listed[0]!.openCommitments).toBe(0);
    expect(listed[2]!.lastInteractionAt).toBeNull();
    expect(commitments.entity.name).toBe('Old Friend');
  });

  /* -------------------------------------------------------------- hand edits */

  it('overwrites a relationship context by hand, and clears it', async () => {
    const ivan = await crm.getOrCreateEntity('Ivan', { relationshipContext: 'neighbour' });

    const set = await crm.setRelationshipContext(ivan.id, '  CNC shop  ');
    if (!set.ok) throw set.error;
    expect(set.value.relationshipContext).toBe('CNC shop');

    const cleared = await crm.setRelationshipContext(ivan.id, '   ');
    if (!cleared.ok) throw cleared.error;
    // Blank is missing everywhere else in the app, so it is NULL and never "".
    expect(cleared.value.relationshipContext).toBeNull();
    const profile = await crm.getEntityProfile(ivan.id);
    if (!profile.ok) throw profile.error;
    expect(profile.value.entity.relationshipContext).toBeNull();

    const missing = await crm.setRelationshipContext('nope', 'whoever');
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected a failure');
    expect(missing.error.code).toBe('not_found');
  });

  it('removes an alias the way a lookup would have matched it', async () => {
    const ivan = await crm.getOrCreateEntity('Ivan Petrov');
    await crm.addAlias(ivan.id, 'Vanya');
    await crm.addAlias(ivan.id, 'Vanko');

    const removed = await crm.removeAlias(ivan.id, 'VANYA');
    if (!removed.ok) throw removed.error;
    expect(parseAliases(removed.value.aliases)).toEqual(['Vanko']);

    // An alias nobody has must not touch the row: `updatedAt` orders the list.
    const later = freezeClock(NOW + 60_000);
    const noop = await crm.removeAlias(ivan.id, 'Nobody');
    if (!noop.ok) throw noop.error;
    expect(noop.value.updatedAt).toBe(removed.value.updatedAt);
    later();

    const emptied = await crm.removeAlias(ivan.id, 'Vanko');
    if (!emptied.ok) throw emptied.error;
    expect(emptied.value.aliases).toBeNull();

    // The name is gone from the contact, so it is free to be someone else.
    const stranger = await crm.getOrCreateEntity('Vanya');
    expect(stranger.id).not.toBe(ivan.id);

    const gone = await crm.removeAlias('nope', 'Vanya');
    expect(gone.ok).toBe(false);
    if (gone.ok) throw new Error('expected a failure');
    expect(gone.error.code).toBe('not_found');
  });

  /* ----------------------------------------------------------------- deletes */

  it('deletes one interaction and leaves the contact and the rest standing', async () => {
    const first = await crm.logInteraction({ entityName: 'Ivan', summary: 'coffee' });
    await crm.logInteraction({ entityName: 'Ivan', summary: 'lent him the drill' });

    const removed = await crm.removeInteraction(first.interaction.id);
    if (!removed.ok) throw removed.error;
    expect(removed.value.summary).toBe('coffee');

    const profile = await crm.getEntityProfile(first.entity.id);
    if (!profile.ok) throw profile.error;
    expect(profile.value.interactions.map((i) => i.summary)).toEqual(['lent him the drill']);
    expect(await crm.listEntities()).toHaveLength(1);

    const missing = await crm.removeInteraction('nope');
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected a failure');
    expect(missing.error.code).toBe('not_found');
  });

  it('deletes one commitment and leaves the task it was linked to alone', async () => {
    const task = await tasks.createTask({ title: 'Send the CAD files' });
    const { entity, commitment } = await crm.addCommitment({
      entityName: 'Ivan',
      commitmentText: 'send the CAD files',
    });
    await crm.linkCommitmentTask(commitment.id, task.id);
    const kept = await crm.addCommitment({ entityName: 'Ivan', commitmentText: 'return the drill' });

    const removed = await crm.removeCommitment(commitment.id);
    if (!removed.ok) throw removed.error;
    expect(removed.value.taskId).toBe(task.id);

    expect((await crm.listCommitmentsFor(entity.id)).map((c) => c.id)).toEqual([
      kept.commitment.id,
    ]);
    // The promise was the contact's; the task is the user's own work.
    expect(await tasks.getTask(task.id)).not.toBeNull();

    const missing = await crm.removeCommitment('nope');
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected a failure');
    expect(missing.error.code).toBe('not_found');
  });

  it('will not delete a contact that has not been confirmed', async () => {
    const { entity } = await crm.addCommitment({
      entityName: 'Ivan',
      commitmentText: 'return the drill',
      interactionSummary: 'Borrowed the drill.',
    });

    const refused = await crm.deleteEntity(entity.id);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected a failure');
    expect(refused.error.code).toBe('invalid_input');

    expect(await crm.listEntities()).toHaveLength(1);
    expect(await crm.listCommitmentsFor(entity.id)).toHaveLength(1);

    const missing = await crm.deleteEntity('nope', { confirmed: true });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected a failure');
    expect(missing.error.code).toBe('not_found');
  });

  it('takes a deleted contact’s history with them, and nothing else', async () => {
    const task = await tasks.createTask({ title: 'Send the CAD files' });
    const { entity, commitment } = await crm.addCommitment({
      entityName: 'Ivan Petrov',
      commitmentText: 'send the CAD files',
      interactionSummary: 'Promised the CAD files by Friday.',
    });
    await crm.linkCommitmentTask(commitment.id, task.id);
    await crm.logInteraction({ entityName: 'Ivan Petrov', summary: 'coffee' });
    const closed = await crm.addCommitment({
      entityName: 'Ivan Petrov',
      commitmentText: 'paid back',
    });
    await crm.completeCommitment(closed.commitment.id);
    await ledger.addTransaction({
      amount: 40,
      currency: 'EUR',
      category: 'Rent',
      entityName: 'Ivan Petrov',
      direction: 'expense',
    });

    // Somebody else with a history of their own: the cascade stops at the row
    // it was handed.
    const maria = await crm.logInteraction({ entityName: 'Maria', summary: 'lunch' });
    await crm.addCommitment({ entityName: 'Maria', commitmentText: 'lend her the drill' });

    const deleted = await crm.deleteEntity(entity.id, { confirmed: true });
    if (!deleted.ok) throw deleted.error;
    expect(deleted.value.entity.name).toBe('Ivan Petrov');
    // Exactly what the screen said would go: two interactions, two commitments.
    expect(deleted.value).toMatchObject({ interactions: 2, commitments: 2, keptTasks: 1 });

    const gone = await crm.getEntityProfile(entity.id);
    expect(gone.ok).toBe(false);
    expect(await crm.listCommitmentsFor(entity.id)).toEqual([]);
    expect((await crm.listEntities()).map((e) => e.entity.name)).toEqual(['Maria']);

    // A linked task is the user's own work and a ledger entry is their own
    // record; neither belongs to the contact.
    expect(await tasks.getTask(task.id)).not.toBeNull();
    expect(await ledger.listForEntity('Ivan Petrov')).toHaveLength(1);

    const survivor = await crm.getEntityProfile(maria.entity.id);
    if (!survivor.ok) throw survivor.error;
    expect(survivor.value.interactions).toHaveLength(1);
    expect(survivor.value.openCommitments).toHaveLength(1);
    expect(await crm.listOpenCommitments()).toHaveLength(1);
  });

  it('leaves the contact untouched when the delete cannot finish', async () => {
    const { entity } = await crm.addCommitment({
      entityName: 'Ivan',
      commitmentText: 'return the drill',
      interactionSummary: 'Borrowed the drill.',
    });
    t.client.execSync(
      `CREATE TRIGGER reject_deletes BEFORE DELETE ON crm_entities
       BEGIN SELECT RAISE(ABORT, 'disk full'); END;`,
    );

    await expect(crm.deleteEntity(entity.id, { confirmed: true })).rejects.toThrow(/disk full/);

    t.client.execSync('DROP TRIGGER reject_deletes');
    expect(await crm.listEntities()).toHaveLength(1);
    expect(await crm.listCommitmentsFor(entity.id)).toHaveLength(1);
    const profile = await crm.getEntityProfile(entity.id);
    if (!profile.ok) throw profile.error;
    expect(profile.value.interactions).toHaveLength(1);
  });
});
