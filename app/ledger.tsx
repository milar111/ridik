import { useMemo, useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { now } from '@/core/clock';
import { countLabel, formatMoney, percent } from '@/core/format';
import { toAppError } from '@/core/result';
import {
  currentZone,
  epochToLocal,
  formatDayHeading,
  formatTime,
  localDateOf,
  localToEpoch,
} from '@/core/time';
import type { Transaction } from '@/db/schema';
import {
  useAddTransaction,
  useCrmEntities,
  useDeleteTransaction,
  useLedgerCategories,
  useLedgerQuery,
  useMonthlyTotals,
  useRecentTransactions,
  useSetting,
  useUpdateTransaction,
} from '@/hooks';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import {
  AnimatedPressable,
  usePressScale,
  useProgressWidth,
  useStaggeredEntry,
} from '@/ui/motionHooks';
import {
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  Input,
  Screen,
  Section,
  Segmented,
  SheetCard,
  Txt,
  useConfirm,
  useToast,
} from '@/ui/components';
import { REFLOW_MS } from '@/ui/motion';

type Period = 'today' | 'week' | 'month' | 'year';
type Direction = 'expense' | 'income';

const PERIODS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

/**
 * The repository answers totals, not rows, so the transaction list is cut out of
 * the recent feed. One window covers a personal year of spending; anything past
 * it is reported honestly rather than silently dropped.
 */
const RECENT_WINDOW = 500;

const TREND_MONTHS = 6;

/**
 * How far back the compose sheet will date a transaction.
 *
 * Spending is remembered rather than filed as it happens, so the last few days
 * have to be reachable — but not by a typed date, which has no map to be caught
 * against and no field on the edit sheet to correct it in afterwards. Four days
 * back is as far as named days stay unambiguous.
 */
const BACKDATE_DAYS = 4;

/** `formatMoney` puts the minus inside the symbol ("€-190"); a net needs it outside. */
function signedMoney(value: number, currency: string): string {
  const magnitude = formatMoney(Math.abs(value), currency);
  return `${value < 0 ? '−' : '+'}${magnitude}`;
}

function reason(error: unknown): string {
  return toAppError(error).userMessage;
}

/** Comma decimals are what a European keyboard offers first. */
function parseAmount(text: string): number | null {
  const parsed = Number(text.replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export default function LedgerScreen() {
  const [period, setPeriod] = useState<Period>('month');
  const [adding, setAdding] = useState(false);

  return (
    <Screen
      back
      title="Ledger"
      right={
        <Button
          icon="add"
          label="Add"
          size="sm"
          variant="primary"
          onPress={() => setAdding(true)}
        />
      }
    >
      <Segmented options={PERIODS} value={period} onChange={setPeriod} />
      <ErrorBoundary label="ledger">
        <LedgerBody period={period} />
      </ErrorBoundary>
      {/* Outside the boundary: a totals card that throws must not take the only
          way to write a row down with it. */}
      {adding ? <AddSheet onClose={() => setAdding(false)} /> : null}
    </Screen>
  );
}

function LedgerBody({ period }: { period: Period }) {
  const { colors, spacing } = useTheme();
  const zone = currentZone();
  const toast = useToast();

  // 'both' so income and expense are both summed: the direction filter would
  // zero one of them and the totals card shows the pair.
  const query = useLedgerQuery({ period, direction: 'both', groupBy: 'category' });
  const recent = useRecentTransactions(RECENT_WINDOW);
  const monthly = useMonthlyTotals(TREND_MONTHS);
  const remove = useDeleteTransaction();
  const confirm = useConfirm();

  const [picked, setPicked] = useState<string | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);
  // Four lists on one screen, four waves. They run at the same time rather than
  // one after another: the totals, the breakdown, the trend and the day groups
  // are separate answers to separate questions, and chaining them would make
  // the last one arrive a second and a half after the first.
  const arriveTotal = useStaggeredEntry({ from: 'below' });
  const arriveBar = useStaggeredEntry({ from: 'below' });
  const arriveTrend = useStaggeredEntry();
  const arriveDay = useStaggeredEntry({ from: 'below' });

  const result = query.data;

  const currencies = useMemo(() => {
    if (!result) return [];
    return [
      ...new Set([
        ...Object.keys(result.expenseByCurrency),
        ...Object.keys(result.incomeByCurrency),
      ]),
    ].sort();
  }, [result]);

  // Derived rather than stored: a period change can retire the picked currency,
  // and an effect that corrects it afterwards would render one wrong frame.
  const currency =
    (picked && currencies.includes(picked) ? picked : (result?.primaryCurrency ?? currencies[0])) ??
    null;

  const rows = useMemo(() => {
    const all = recent.data ?? [];
    const from = result?.from ?? null;
    const to = result?.to ?? null;
    return all.filter(
      (tx) => (from === null || tx.createdAt >= from) && (to === null || tx.createdAt < to),
    );
  }, [recent.data, result]);

  const days = useMemo(() => {
    const buckets = new Map<string, Transaction[]>();
    for (const tx of rows) {
      const key = localDateOf(tx.createdAt, zone);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(tx);
      else buckets.set(key, [tx]);
    }
    return [...buckets.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [rows, zone]);

  const bars = useMemo(() => {
    if (!result || !currency) return [];
    const entries = result.groups
      .map((group) => ({ key: group.key, amount: group.expenseByCurrency[currency] ?? 0 }))
      .filter((entry) => entry.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    const total = entries.reduce((sum, entry) => sum + entry.amount, 0);
    const max = entries[0]?.amount ?? 0;
    return entries.map((entry) => ({
      ...entry,
      share: percent(entry.amount, total),
      fill: max > 0 ? entry.amount / max : 0,
    }));
  }, [result, currency]);

  const trend = useMemo(() => {
    if (!currency) return { months: [], peak: 0 };
    const months = (monthly.data ?? []).map((bucket) => ({
      month: bucket.month,
      label: epochToLocal(bucket.start, zone).toFormat('LLL'),
      value: bucket.expense[currency] ?? 0,
    }));
    const peak = months.reduce((max, m) => Math.max(max, m.value), 0);
    return { months, peak };
  }, [monthly.data, currency, zone]);

  const confirmDelete = (tx: Transaction) => {
    confirm.ask({
      title: 'Delete this transaction?',
      message: `${tx.description ?? tx.category} · ${formatMoney(tx.amount, tx.currency)}`,
      onConfirm: () =>
        remove.mutate(tx.id, {
          onSuccess: () => {
            setEditing(null);
            toast.show({ message: 'Transaction deleted' });
          },
          onError: (error) =>
            toast.show({ message: 'Could not delete that', detail: reason(error), tone: 'danger' }),
        }),
    });
  };

  if (query.isError) {
    return <RetryRow message={reason(query.error)} onRetry={() => void query.refetch()} />;
  }

  if (!result) return <SkeletonRows />;

  if (result.count === 0) {
    return (
      <EmptyState
        icon="wallet-outline"
        title="Nothing recorded in this period"
        hint="Try: 'spent 12 euros on 3D printer filament'"
      />
    );
  }

  const span =
    result.from === null || result.to === null
      ? 'All time'
      : `${epochToLocal(result.from, zone).toFormat('d LLL')} – ${epochToLocal(
          // The end bound is exclusive; showing it raw dates the period a day long.
          result.to - 1,
          zone,
        ).toFormat('d LLL')}`;

  return (
    <View style={{ gap: spacing.lg }}>
      <View style={styles.spread}>
        <Txt variant="caption" tone="secondary">
          {span}
        </Txt>
        <Txt variant="caption" tone="tertiary">
          {countLabel(result.count, 'transaction')}
        </Txt>
      </View>

      {/* One card per currency: a summed EUR+USD number is a lie that reads
          like a fact, so they never share a total. */}
      <View style={{ gap: spacing.sm }}>
        {currencies.map((code, i) => (
          <Animated.View
            key={code}
            entering={arriveTotal(i)}
            // A period with no spending in one of the currencies drops its card
            // out of the stack entirely.
            layout={LinearTransition.duration(REFLOW_MS)}
          >
            <TotalCard
              code={code}
              spent={result.expenseByCurrency[code] ?? 0}
              received={result.incomeByCurrency[code] ?? 0}
              net={result.netByCurrency[code] ?? 0}
            />
          </Animated.View>
        ))}
      </View>

      {currencies.length > 1 && currency ? (
        <View style={styles.chipRow}>
          {currencies.map((code) => (
            <Chip
              key={code}
              label={code}
              size="sm"
              selected={code === currency}
              onPress={() => setPicked(code)}
            />
          ))}
        </View>
      ) : null}

      {currency && bars.length > 0 ? (
        <Section title={`Where it went · ${currency}`}>
          <Card>
            {bars.map((bar, i) => (
              // Sorted by amount, so a new transaction can lift a category past
              // two others; keyed on the category, so `layout` carries the row
              // to its new rank instead of relabelling the rows in place.
              <Animated.View
                key={bar.key}
                entering={arriveBar(i)}
                layout={LinearTransition.duration(REFLOW_MS)}
              >
                {i > 0 ? <Divider /> : null}
                <BreakdownBar
                  name={bar.key}
                  amount={bar.amount}
                  currency={currency}
                  share={bar.share}
                  fill={bar.fill}
                />
              </Animated.View>
            ))}
          </Card>
        </Section>
      ) : null}

      {currency && trend.peak > 0 ? (
        <Section
          title="6-month trend"
          right={
            <Txt variant="micro" tone="tertiary">
              peak {formatMoney(trend.peak, currency, { compact: true })}
            </Txt>
          }
        >
          <Card>
            <View style={styles.trend}>
              {trend.months.map((month, i) => {
                const latest = i === trend.months.length - 1;
                return (
                  // Left to right, fading in place: the columns are read as a
                  // sequence in time, and six of them sliding up from below
                  // would be six bars growing the wrong way.
                  <Animated.View
                    key={month.month}
                    entering={arriveTrend(i)}
                    style={styles.trendColumn}
                  >
                    <Animated.View
                      accessibilityRole="image"
                      accessibilityLabel={`${month.label}: ${formatMoney(month.value, currency)}`}
                      // Switching currency redraws all six to new heights at
                      // once. `layout` is what animates a *size* change without
                      // a shared value per bar: the column is the same view, it
                      // just measures differently, which is exactly the case
                      // `LinearTransition` covers.
                      layout={LinearTransition.duration(REFLOW_MS)}
                      style={{
                        width: '70%',
                        // +2 so an empty month still reads as a baseline tick.
                        height: 2 + Math.round((month.value / trend.peak) * 56),
                        borderRadius: 3,
                        backgroundColor: latest ? colors.accent : colors.accentMuted,
                      }}
                    />
                    <Txt variant="micro" tone={latest ? 'secondary' : 'tertiary'}>
                      {month.label}
                    </Txt>
                  </Animated.View>
                );
              })}
            </View>
          </Card>
        </Section>
      ) : null}

      <Section
        title="Transactions"
        right={
          rows.length < result.count ? (
            <Txt variant="micro" tone="tertiary">
              latest {rows.length} of {result.count}
            </Txt>
          ) : null
        }
      >
        {recent.isPending && rows.length === 0 ? (
          <SkeletonRows count={3} />
        ) : (
          days.map(([date, entries], dayIndex) => (
            // The day is the unit that arrives; its rows come with it. Two
            // nested staggers on one list is a list that takes a second and a
            // half to finish assembling itself.
            <Animated.View
              key={date}
              entering={arriveDay(dayIndex)}
              layout={LinearTransition.duration(REFLOW_MS)}
              style={{ gap: 4 }}
            >
              <View style={[styles.spread, { paddingTop: spacing.xs }]}>
                <Txt variant="micro" tone="tertiary" style={styles.tracked}>
                  {formatDayHeading(entries[0]!.createdAt, zone).toUpperCase()}
                </Txt>
                <Txt variant="micro" tone="tertiary">
                  {dayTotals(entries)}
                </Txt>
              </View>
              <Card padded={false}>
                {entries.map((tx, i) => (
                  // `layout` only — no second entrance. Deleting a transaction
                  // takes a row out of the middle of the day and the rows below
                  // it have to close the gap rather than jump.
                  <Animated.View key={tx.id} layout={LinearTransition.duration(REFLOW_MS)}>
                    {i > 0 ? <Divider inset={spacing.md} /> : null}
                    <TransactionRow tx={tx} onEdit={() => setEditing(tx)} />
                  </Animated.View>
                ))}
              </Card>
            </Animated.View>
          ))
        )}
      </Section>

      {editing ? (
        <EditSheet
          key={editing.id}
          tx={editing}
          onClose={() => setEditing(null)}
          onDelete={() => confirmDelete(editing)}
        />
      ) : null}
      {confirm.dialog}
    </View>
  );
}

/** Per-currency day subtotal, listed side by side — never added together. */
function dayTotals(entries: readonly Transaction[]): string {
  const sums = new Map<string, number>();
  for (const tx of entries) {
    const signed = tx.direction === 'income' ? tx.amount : -tx.amount;
    sums.set(tx.currency, (sums.get(tx.currency) ?? 0) + signed);
  }
  return [...sums.entries()].map(([code, value]) => signedMoney(value, code)).join(' · ');
}

function TotalCard({
  code,
  spent,
  received,
  net,
}: {
  code: string;
  spent: number;
  received: number;
  net: number;
}) {
  const { spacing } = useTheme();
  return (
    <Card>
      <View style={styles.spread}>
        <Txt variant="micro" tone="tertiary" style={styles.tracked}>
          {code}
        </Txt>
        <Txt variant="micro" tone="tertiary" style={styles.tracked}>
          SPENT
        </Txt>
      </View>
      <Txt variant="display">{formatMoney(spent, code)}</Txt>
      {/* A zero is not an event, and it must not be painted like one. Both of
          these were coloured unconditionally, so a month with no income at all
          drew €0.00 in the cool "money came in" slate — the app's one
          non-ember accent, spent on the absence of the thing it means — and a
          net of exactly zero was reported as a good outcome. The same argument
          as an empty checkbox not being a state worth a colour. */}
      <View style={{ flexDirection: 'row', gap: spacing.xl, marginTop: 2 }}>
        <Stat
          label="In"
          value={formatMoney(received, code)}
          tone={received > 0 ? 'success' : 'secondary'}
        />
        <Stat label="Net" value={signedMoney(net, code)} tone={net > 0 ? 'success' : 'primary'} />
      </View>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'success' | 'primary' | 'secondary';
}) {
  return (
    <View style={{ gap: 1 }}>
      <Txt variant="micro" tone="tertiary" style={styles.tracked}>
        {label.toUpperCase()}
      </Txt>
      <Txt variant="bodyStrong" tone={tone}>
        {value}
      </Txt>
    </View>
  );
}

function BreakdownBar({
  name,
  amount,
  currency,
  share,
  fill,
}: {
  name: string;
  amount: number;
  currency: string;
  share: number;
  fill: number;
}) {
  const { colors, spacing } = useTheme();
  // The floor is kept inside the fraction rather than applied to the width, so
  // the animated bar lands on exactly the same 2% stub the static one drew.
  // Timing, not spring: a bar that overshoots its track has lied about a number.
  const fillStyle = useProgressWidth(Math.max(0.02, fill));

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${name}, ${formatMoney(amount, currency)}, ${share} percent`}
      style={{ gap: 5, paddingVertical: spacing.sm }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Txt variant="caption" style={{ flex: 1 }} numberOfLines={1}>
          {name}
        </Txt>
        <Txt variant="caption" weight="600">
          {formatMoney(amount, currency)}
        </Txt>
        <Txt variant="micro" tone="tertiary" style={styles.share}>
          {share}%
        </Txt>
      </View>
      <View style={[styles.track, { backgroundColor: colors.surfaceSunken }]}>
        <Animated.View
          style={[
            {
              height: '100%',
              // A visible stub keeps a 0% row from reading as missing data.
              borderRadius: 3,
              // One ink for every bar. A colour per category was hashed from the
              // word, so four rows here came out the same tan more often than
              // not — and even when they did not, the length is the datum and
              // the name is already written above it. Spending is money going
              // out, which in this palette is warm, so the bars are the ember.
              backgroundColor: colors.accent,
            },
            fillStyle,
          ]}
        />
      </View>
    </View>
  );
}

function TransactionRow({ tx, onEdit }: { tx: Transaction; onEdit: () => void }) {
  const { colors, spacing } = useTheme();
  const income = tx.direction === 'income';
  const money = formatMoney(tx.amount, tx.currency);
  const title = tx.description?.trim() || tx.category;
  const press = usePressScale({ scale: 0.98 });

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${income ? 'received' : 'spent'} ${money}`}
      accessibilityHint="Tap to edit"
      onPress={onEdit}
      {...press.handlers}
      style={[styles.txRow, { paddingHorizontal: spacing.md }, press.style]}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Txt variant="body" numberOfLines={1}>
          {title}
        </Txt>
        <View style={styles.meta}>
          <Chip label={tx.category} size="sm" />
          {tx.entityName ? (
            <Txt variant="micro" tone="tertiary" numberOfLines={1}>
              {tx.entityName}
            </Txt>
          ) : null}
          <Txt variant="micro" tone="tertiary">
            {formatTime(tx.createdAt)}
          </Txt>
        </View>
      </View>
      <Txt variant="bodyStrong" style={{ color: income ? colors.success : colors.text }}>
        {income ? `+${money}` : money}
      </Txt>
    </AnimatedPressable>
  );
}

function EditSheet({
  tx,
  onClose,
  onDelete,
}: {
  tx: Transaction;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { spacing } = useTheme();
  const toast = useToast();
  const update = useUpdateTransaction();
  const categories = useLedgerCategories();
  const entities = useCrmEntities();

  const [amount, setAmount] = useState(String(tx.amount));
  const [category, setCategory] = useState(tx.category);
  const [description, setDescription] = useState(tx.description ?? '');
  const [entity, setEntity] = useState(tx.entityName ?? '');
  const [direction, setDirection] = useState<Direction>(tx.direction);

  const entityNames = useMemo(
    () => (entities.data ?? []).map((summary) => summary.entity.name),
    [entities.data],
  );

  const save = () => {
    const parsed = parseAmount(amount);
    if (parsed === null) {
      toast.show({ message: 'That amount is not a number', tone: 'danger' });
      return;
    }
    if (!category.trim()) {
      toast.show({ message: 'Pick a category', tone: 'danger' });
      return;
    }
    update.mutate(
      {
        id: tx.id,
        patch: {
          amount: parsed,
          category,
          description,
          entityName: entity,
          direction,
        },
      },
      {
        onSuccess: () => {
          toast.show({ message: 'Transaction updated', tone: 'success' });
          onClose();
        },
        onError: (error) =>
          toast.show({ message: 'Could not save that', detail: reason(error), tone: 'danger' }),
      },
    );
  };

  return (
    <Sheet
      title="Edit transaction"
      onClose={onClose}
      footer={
        <>
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Button
              label="Save"
              variant="primary"
              onPress={save}
              loading={update.isPending}
              style={{ flex: 1 }}
            />
            <Button label="Cancel" variant="ghost" onPress={onClose} />
          </View>

          <Button
            label="Delete"
            icon="trash-outline"
            variant="danger"
            fullWidth
            onPress={onDelete}
          />
        </>
      }
    >
      <Input
        label={`Amount (${tx.currency})`}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
      />

      <ChipField
        label="Category"
        options={categories.data ?? []}
        value={category}
        onChange={setCategory}
        placeholder="New category"
      />

      <Input label="Description" value={description} onChangeText={setDescription} />

      <ChipField
        label="Person or place"
        options={entityNames}
        value={entity}
        onChange={setEntity}
        noneLabel="None"
        placeholder="New name"
      />

      <Segmented
        value={direction}
        onChange={setDirection}
        options={[
          { value: 'expense', label: 'Expense' },
          { value: 'income', label: 'Income' },
        ]}
      />
    </Sheet>
  );
}

/**
 * The typed way in.
 *
 * The voice executor was the only writer, so an install without an LLM key had
 * a Money screen it could read and never add to. Same fields as the edit sheet,
 * in the same order, plus the one thing an edit does not need: which day this
 * happened on, because a spend is usually written down after the fact.
 */
function AddSheet({ onClose }: { onClose: () => void }) {
  const { spacing } = useTheme();
  const zone = currentZone();
  const toast = useToast();
  const add = useAddTransaction();
  const categories = useLedgerCategories();
  const entities = useCrmEntities();
  // No picker beside it, for the same reason the edit sheet has none: a
  // per-row currency is a second place to get it wrong, and the setting
  // already answers the question for every row this screen will ever add.
  const currency = useSetting('primaryCurrency').value;

  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [entity, setEntity] = useState('');
  const [direction, setDirection] = useState<Direction>('expense');
  const [daysBack, setDaysBack] = useState(0);

  const entityNames = useMemo(
    () => (entities.data ?? []).map((summary) => summary.entity.name),
    [entities.data],
  );

  const days = useMemo(() => dayLabels(zone), [zone]);

  const save = () => {
    const parsed = parseAmount(amount);
    if (parsed === null) {
      toast.show({ message: 'That amount is not a number', tone: 'danger' });
      return;
    }
    if (!category.trim()) {
      toast.show({ message: 'Pick a category', tone: 'danger' });
      return;
    }
    add.mutate(
      {
        amount: parsed,
        currency,
        category,
        description,
        entityName: entity,
        direction,
        at: epochForDay(daysBack, zone),
        zone,
      },
      {
        onSuccess: () => {
          toast.show({ message: 'Transaction added', tone: 'success' });
          onClose();
        },
        onError: (error) =>
          toast.show({ message: 'Could not save that', detail: reason(error), tone: 'danger' }),
      },
    );
  };

  return (
    <Sheet
      title="New transaction"
      onClose={onClose}
      footer={
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Button
            label="Add transaction"
            variant="primary"
            onPress={save}
            loading={add.isPending}
            style={{ flex: 1 }}
          />
          <Button label="Cancel" variant="ghost" onPress={onClose} />
        </View>
      }
    >
      <Input
        label={`Amount (${currency})`}
        testID="transaction-amount"
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        autoFocus
      />

      <ChipField
        label="Category"
        options={categories.data ?? []}
        value={category}
        onChange={setCategory}
        placeholder="New category"
      />

      <Input
        label="Description"
        testID="transaction-description"
        value={description}
        onChangeText={setDescription}
      />

      <ChipField
        label="Person or place"
        options={entityNames}
        value={entity}
        onChange={setEntity}
        noneLabel="None"
        placeholder="New name"
      />

      <Segmented
        value={direction}
        onChange={setDirection}
        options={[
          { value: 'expense', label: 'Expense' },
          { value: 'income', label: 'Income' },
        ]}
      />

      <View style={{ gap: 5 }}>
        <Txt variant="micro" tone="tertiary" style={styles.fieldLabel}>
          WHEN
        </Txt>
        <View style={styles.chipRow}>
          {days.map((label, back) => (
            <Chip
              key={label}
              label={label}
              size="sm"
              selected={back === daysBack}
              onPress={() => setDaysBack(back)}
            />
          ))}
        </View>
      </View>
    </Sheet>
  );
}

/** The chips of the WHEN field: today first, then back through named days. */
function dayLabels(zone: string): string[] {
  const today = epochToLocal(now(), zone);
  return Array.from({ length: BACKDATE_DAYS + 1 }, (_, back) =>
    back === 0 ? 'Today' : back === 1 ? 'Yesterday' : today.minus({ days: back }).toFormat('cccc'),
  );
}

/**
 * Today is the moment of saving, so the row lands in the feed where it
 * happened. An earlier day is noon rather than midnight, because a zone that
 * skips its own midnight on a switchover would drop the row into the day
 * before.
 */
function epochForDay(back: number, zone: string): number {
  const at = now();
  if (back === 0) return at;
  const date = epochToLocal(at, zone).minus({ days: back }).toISODate();
  return date === null ? at : localToEpoch(`${date}T12:00`, zone);
}

/** The chrome both transaction sheets wear, so neither can drift from the other. */
function Sheet({
  title,
  onClose,
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]}
        onPress={onClose}
      />
      {/* A Modal is its own window on Android, so the activity's adjustResize
          never reaches it and the keyboard sits over the field it just opened. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.sheetWrap}
      >
        <SheetCard
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              paddingBottom: insets.bottom + spacing.lg,
              gap: spacing.md,
            },
          ]}
        >
          <Txt variant="heading">{title}</Txt>

          <ScrollView
            style={{ maxHeight: 420 }}
            contentContainerStyle={{ gap: spacing.md }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>

          {footer}
        </SheetCard>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * A join key, offered as the spellings that already exist.
 *
 * Both fields this renders are keys, not labels: a category is what the
 * "Where it went" breakdown groups on, and an entity name is the only thing
 * tying a transaction to a person's Money section. Typed freely, "Groceries "
 * forks the chart and "Ivo Petrov " detaches the row, and nothing in the app
 * can merge either back — so typing is the second offer, not the first.
 */
function ChipField({
  label,
  options,
  value,
  onChange,
  noneLabel,
  placeholder,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (next: string) => void;
  noneLabel?: string;
  placeholder: string;
}) {
  // Latched by the New chip; otherwise derived, so a value that renders before
  // its options arrive stops looking new the moment they land.
  const [typing, setTyping] = useState(false);
  const unlisted = value !== '' && !options.includes(value);
  const editing = typing || unlisted;

  const pick = (next: string) => {
    setTyping(false);
    onChange(next);
  };

  return (
    <View style={{ gap: 5 }}>
      <Txt variant="micro" tone="tertiary" style={styles.fieldLabel}>
        {label.toUpperCase()}
      </Txt>
      <View style={styles.chipRow}>
        {noneLabel ? (
          <Chip
            label={noneLabel}
            size="sm"
            selected={!editing && value === ''}
            onPress={() => pick('')}
          />
        ) : null}
        {options.map((option) => (
          <Chip
            key={option}
            label={option}
            size="sm"
            selected={!editing && option === value}
            onPress={() => pick(option)}
          />
        ))}
        <Chip
          label="New"
          icon="add"
          size="sm"
          selected={editing}
          onPress={() => {
            setTyping(true);
            if (!unlisted) onChange('');
          }}
        />
      </View>
      {editing ? (
        <Input
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          autoCapitalize="none"
          autoFocus={typing}
        />
      ) : null}
    </View>
  );
}

function RetryRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { colors, spacing } = useTheme();
  return (
    <Card style={{ borderColor: colors.danger }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <Txt variant="caption" tone="danger" style={{ flex: 1 }}>
          {message}
        </Txt>
        <Button label="Retry" size="sm" onPress={onRetry} />
      </View>
    </Card>
  );
}

function SkeletonRows({ count = 4 }: { count?: number }) {
  const { colors, spacing } = useTheme();
  return (
    <Card padded={false}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={{ padding: spacing.md, gap: 7 }}>
          <View
            style={[
              styles.bone,
              { width: `${68 - i * 9}%`, height: 11, backgroundColor: colors.surfaceRaised },
            ]}
          />
          <View
            style={[
              styles.bone,
              { width: '32%', height: 8, backgroundColor: colors.surfaceSunken },
            ]}
          />
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  tracked: { letterSpacing: 0.8 },
  fieldLabel: { letterSpacing: 0.6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  share: { width: 34, textAlign: 'right' },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  trend: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 82 },
  trendColumn: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 5 },
  txRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingVertical: 8 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: { paddingHorizontal: 18, paddingTop: 14, borderWidth: StyleSheet.hairlineWidth },
  bone: { borderRadius: 4 },
});
