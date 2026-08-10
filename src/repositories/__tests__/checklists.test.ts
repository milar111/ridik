import { freezeClock, resetClock } from '@/core/clock';
import { createTestDatabase, type TestDatabase } from '@/db/testing';
import { createChecklistsRepository, type ChecklistsRepository } from '@/repositories/checklists';

const AT = Date.UTC(2026, 2, 10, 8, 0);

describe('checklists repository', () => {
  let t: TestDatabase;
  let repo: ChecklistsRepository;

  beforeEach(() => {
    t = createTestDatabase();
    repo = createChecklistsRepository(t.db);
    freezeClock(AT);
  });

  afterEach(() => {
    resetClock();
    t.close();
  });

  it('adds plain strings and {text, quantity} objects with sequential order indexes', async () => {
    const result = await repo.addItems('shopping', ['milk', { text: 'eggs', quantity: '12' }]);

    expect(result.added).toHaveLength(2);
    expect(result.reopened).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);

    const items = await repo.itemsForList('shopping');
    expect(items.map((i) => [i.itemText, i.quantity, i.orderIndex])).toEqual([
      ['milk', null, 0],
      ['eggs', '12', 1],
    ]);
    expect(items.every((i) => i.isCompleted === false)).toBe(true);
  });

  it('continues order indexes across separate adds and treats the list name as case-insensitive', async () => {
    await repo.addItems('Shopping', ['milk']);
    const second = await repo.addItems('shopping', ['bread']);

    expect(second.added[0]!.orderIndex).toBe(1);
    expect(await repo.itemsForList('SHOPPING')).toHaveLength(2);
    expect(await repo.listNames()).toEqual([{ name: 'Shopping', open: 2, total: 2 }]);
  });

  it('dedupes case-insensitively against open items, updating only the quantity', async () => {
    await repo.addItems('shopping', ['Milk']);
    const again = await repo.addItems('shopping', [{ text: 'milk', quantity: '2 l' }]);

    expect(again.added).toHaveLength(0);
    expect(again.duplicates).toHaveLength(1);
    expect(again.duplicates[0]!.quantity).toBe('2 l');

    const items = await repo.itemsForList('shopping');
    expect(items).toHaveLength(1);
    expect(items[0]!.itemText).toBe('Milk');
  });

  it('dedupes repeats inside a single batch', async () => {
    const result = await repo.addItems('shopping', ['tape', 'Tape', 'tape']);

    expect(result.added).toHaveLength(1);
    expect(result.duplicates).toHaveLength(2);
    expect(await repo.itemsForList('shopping')).toHaveLength(1);
  });

  it('re-adding an item that was ticked off reopens it instead of duplicating', async () => {
    await repo.addItems('shopping', ['bread']);
    const toggled = await repo.toggle({ listName: 'shopping', itemQuery: 'bread' });
    expect(toggled.ok).toBe(true);

    const result = await repo.addItems('shopping', ['Bread']);
    expect(result.reopened).toHaveLength(1);
    expect(result.added).toHaveLength(0);

    const items = await repo.itemsForList('shopping');
    expect(items).toHaveLength(1);
    expect(items[0]!.isCompleted).toBe(false);
    expect(items[0]!.completedAt).toBeNull();
  });

  it('resolves a fuzzy toggle across every list when no list is named', async () => {
    await repo.addItems('groceries', ['milk', 'bread']);
    await repo.addItems('hardware', ['M3 screws']);

    const result = await repo.toggle({ itemQuery: 'bred' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.itemText).toBe('bread');
    expect(result.value.listName).toBe('groceries');
    expect(result.value.isCompleted).toBe(true);
    expect(result.value.completedAt).toBe(AT);
  });

  it('matches on the list name too when searching across lists', async () => {
    await repo.addItems('shopping', ['milk']);
    await repo.addItems('packing', ['socks']);

    const result = await repo.toggle({ itemQuery: 'milk on the shopping list' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.itemText).toBe('milk');
  });

  it('reports ambiguity rather than guessing between identical items on two lists', async () => {
    await repo.addItems('groceries', ['milk']);
    await repo.addItems('corner shop', ['milk']);

    const result = await repo.toggle({ itemQuery: 'milk' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ambiguous');
    const details = result.error.details as { matches: { listName: string }[] };
    expect(details.matches.map((m) => m.listName).sort()).toEqual(['corner shop', 'groceries']);

    // nothing was touched
    expect((await repo.itemsForList('groceries'))[0]!.isCompleted).toBe(false);
    expect((await repo.itemsForList('corner shop'))[0]!.isCompleted).toBe(false);
  });

  it('reports not_found for an item nobody has on a list', async () => {
    await repo.addItems('shopping', ['milk']);

    const result = await repo.toggle({ itemQuery: 'snowboard wax' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
  });

  it('scopes the search to one list when the list is named', async () => {
    await repo.addItems('groceries', ['milk']);
    await repo.addItems('packing', ['charger']);

    const result = await repo.toggle({ listName: 'packing', itemQuery: 'milk' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
  });

  it('un-completes an item and clears completed_at', async () => {
    await repo.addItems('shopping', ['milk']);
    await repo.toggle({ itemQuery: 'milk' });

    const result = await repo.toggle({ itemQuery: 'milk', completed: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isCompleted).toBe(false);
    expect(result.value.completedAt).toBeNull();
  });

  it('counts open and total per list', async () => {
    await repo.addItems('groceries', ['milk', 'bread', 'jam']);
    await repo.addItems('packing', ['socks']);
    await repo.toggle({ listName: 'groceries', itemQuery: 'jam' });

    expect(await repo.listNames()).toEqual([
      { name: 'groceries', open: 2, total: 3 },
      { name: 'packing', open: 1, total: 1 },
    ]);
  });

  it('orders items by completion then order index, and can hide completed ones', async () => {
    await repo.addItems('groceries', ['milk', 'bread', 'jam']);
    await repo.toggle({ listName: 'groceries', itemQuery: 'milk' });

    const all = await repo.itemsForList('groceries');
    expect(all.map((i) => i.itemText)).toEqual(['bread', 'jam', 'milk']);

    const open = await repo.itemsForList('groceries', { includeCompleted: false });
    expect(open.map((i) => i.itemText)).toEqual(['bread', 'jam']);
  });

  it('clears only the completed items of one list', async () => {
    await repo.addItems('groceries', ['milk', 'bread']);
    await repo.addItems('packing', ['socks']);
    await repo.toggle({ listName: 'groceries', itemQuery: 'milk' });
    await repo.toggle({ listName: 'packing', itemQuery: 'socks' });

    expect(await repo.clearCompleted('groceries')).toBe(1);
    expect((await repo.itemsForList('groceries')).map((i) => i.itemText)).toEqual(['bread']);
    expect(await repo.itemsForList('packing')).toHaveLength(1);
  });

  it('removes a single item by id', async () => {
    const { added } = await repo.addItems('shopping', ['milk']);

    expect(await repo.removeItem(added[0]!.id)).toBe(true);
    expect(await repo.removeItem(added[0]!.id)).toBe(false);
    expect(await repo.itemsForList('shopping')).toHaveLength(0);
  });

  it('renames a list, shifting order indexes past the tail of the target list', async () => {
    await repo.addItems('van', ['rope', 'tarp']);
    await repo.addItems('trailer', ['straps']);

    expect(await repo.renameList('Van', 'trailer')).toBe(2);
    expect((await repo.itemsForList('trailer')).map((i) => [i.itemText, i.orderIndex])).toEqual([
      ['straps', 0],
      ['rope', 1],
      ['tarp', 2],
    ]);
    expect(await repo.itemsForList('van')).toHaveLength(0);
  });

  it('re-cases a list name without disturbing its order', async () => {
    await repo.addItems('van', ['rope', 'tarp']);

    expect(await repo.renameList('van', 'Van')).toBe(2);
    expect((await repo.itemsForList('van')).map((i) => [i.itemText, i.orderIndex])).toEqual([
      ['rope', 0],
      ['tarp', 1],
    ]);
    expect((await repo.listNames())[0]!.name).toBe('Van');
  });

  it('tolerates a padded list name on every read and write path', async () => {
    await repo.addItems('  shopping  ', ['milk', 'bread']);
    await repo.toggle({ listName: 'shopping', itemQuery: 'milk' });

    expect(await repo.itemsForList('  shopping ')).toHaveLength(2);
    expect(await repo.itemsForList(' shopping', { includeCompleted: false })).toHaveLength(1);
    expect((await repo.listNames())[0]!.name).toBe('shopping');
    expect(await repo.clearCompleted(' shopping ')).toBe(1);
    expect(await repo.itemsForList('shopping')).toHaveLength(1);
  });

  it('rolls the whole batch back when one item cannot be written', async () => {
    await repo.addItems('shopping', ['milk']);

    // A project that does not exist trips the foreign key on the second insert.
    await expect(
      repo.addItems('shopping', ['eggs', 'bread'], 'no-such-project'),
    ).rejects.toThrow();

    expect((await repo.itemsForList('shopping')).map((i) => i.itemText)).toEqual(['milk']);
  });

  it('updates text and quantity by id, and clears a quantity with null', async () => {
    const { added } = await repo.addItems('shopping', [{ text: 'milk', quantity: '1 l' }]);
    const id = added[0]!.id;

    const renamed = await repo.updateItem(id, { itemText: '  oat milk  ', quantity: '2 l' });
    expect(renamed?.itemText).toBe('oat milk');
    expect(renamed?.quantity).toBe('2 l');

    const cleared = await repo.updateItem(id, { quantity: null });
    expect(cleared?.quantity).toBeNull();

    expect(await repo.updateItem('nope', { itemText: 'x' })).toBeNull();
  });
});
