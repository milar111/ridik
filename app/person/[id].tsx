import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, type DimensionValue } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { countLabel, formatMoney, truncate } from '@/core/format';
import { epochToLocal, formatDayHeading, formatRelative } from '@/core/time';
import type { CrmCommitment, CrmInteraction, Transaction } from '@/db/schema';
import {
  useAddCommitment,
  useAddEntityAlias,
  useCompleteCommitment,
  useCrmProfile,
  useLogInteraction,
  useRemoveEntityAlias,
  useTask,
  useUpdateEntityContext,
} from '@/hooks';
import type { CommitmentDirection, CrmEntityProfile } from '@/repositories/crm';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  Divider,
  EmptyState,
  Input,
  Screen,
  Section,
  Segmented,
  Txt,
  useToast,
} from '@/ui/components';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import { colorForTag } from '@/ui/theme';

/** What to say to fill this screen — the empty state is the tutorial. */
const VOICE_HINT = "Try: 'Ivo owes me 200 leva for the plywood, remind me on Friday'";

const TX_PREVIEW = 6;
const HISTORY_PREVIEW = 10;

/** Aligns a commitment's meta line under its label: 21pt box + 10pt gap. */
const CHECKBOX_INSET = 31;

export default function PersonDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const profile = useCrmProfile(id);

  return (
    <Screen>
      <ErrorBoundary
        label="person"
        fallback={(error, reset) => <InlineError message={error.message} onRetry={reset} />}
      >
        <ScreenHeader profile={profile.data} />
        {profile.isPending ? (
          <SkeletonBlock />
        ) : profile.isError ? (
          <InlineError
            message={profile.error.message}
            onRetry={() => {
              void profile.refetch();
            }}
          />
        ) : profile.data ? (
          <PersonBody profile={profile.data} />
        ) : null}
      </ErrorBoundary>
    </Screen>
  );
}

/* -------------------------------------------------------------------- body -- */

function PersonBody({ profile }: { profile: CrmEntityProfile }) {
  const { spacing } = useTheme();
  const toast = useToast();
  const complete = useCompleteCommitment();

  const [composer, setComposer] = useState<'none' | 'commitment' | 'interaction'>('none');
  // Optimistic overrides keyed by commitment id: the checkbox flips now, the
  // refetch drops the entry, and a failure puts the old value straight back.
  const [override, setOverride] = useState<Record<string, boolean>>({});

  const { entity, openCommitments, completedCommitments, interactions, transactions } = profile;
  const blank =
    openCommitments.length === 0 &&
    completedCommitments.length === 0 &&
    interactions.length === 0 &&
    transactions.length === 0;

  const checkedOf = (c: CrmCommitment) => override[c.id] ?? Boolean(c.isCompleted);

  // Annotated because the undo action refers to it from inside its own body.
  const setCommitment: (c: CrmCommitment, next: boolean) => void = (c, next) => {
    setOverride((prev) => ({ ...prev, [c.id]: next }));
    complete.mutate(
      { id: c.id, completed: next },
      {
        onSuccess: () => {
          if (!next) return;
          toast.show({
            message: 'Commitment closed',
            detail: truncate(c.commitmentText, 60),
            tone: 'success',
            action: { label: 'Undo', onPress: () => setCommitment(c, false) },
          });
        },
        onError: (error) => {
          setOverride((prev) => ({ ...prev, [c.id]: Boolean(c.isCompleted) }));
          toast.show({ message: 'Could not save that', detail: error.message, tone: 'danger' });
        },
        // The hook invalidates and refetches before this runs, so by now the row
        // has moved to the list it belongs in and the override is dead weight.
        onSettled: () =>
          setOverride((prev) => {
            const next2 = { ...prev };
            delete next2[c.id];
            return next2;
          }),
      },
    );
  };

  return (
    <>
      <IdentityBlock profile={profile} />

      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Button
          label="Commitment"
          icon={composer === 'commitment' ? 'close' : 'add'}
          size="sm"
          onPress={() => setComposer((c) => (c === 'commitment' ? 'none' : 'commitment'))}
        />
        <Button
          label="Interaction"
          icon={composer === 'interaction' ? 'close' : 'add'}
          size="sm"
          onPress={() => setComposer((c) => (c === 'interaction' ? 'none' : 'interaction'))}
        />
      </View>

      {composer === 'commitment' ? (
        <CommitmentComposer entityName={entity.name} onDone={() => setComposer('none')} />
      ) : null}
      {composer === 'interaction' ? (
        <InteractionComposer entityName={entity.name} onDone={() => setComposer('none')} />
      ) : null}

      {blank ? (
        <EmptyState icon="chatbubbles-outline" title="Nothing recorded yet" hint={VOICE_HINT} />
      ) : (
        <>
          <Section
            title="Open commitments"
            right={
              openCommitments.length > 0 ? (
                <Txt variant="micro" tone="tertiary">
                  {countLabel(openCommitments.length, 'open')}
                </Txt>
              ) : null
            }
          >
            {openCommitments.length === 0 ? (
              <MutedRow icon="checkmark-done-outline" text="Nothing outstanding." />
            ) : (
              <Card padded={false}>
                {openCommitments.map((c, i) => (
                  <View key={c.id}>
                    {i > 0 ? <Divider inset={CHECKBOX_INSET + 12} /> : null}
                    <CommitmentRow
                      commitment={c}
                      checked={checkedOf(c)}
                      onToggle={(next) => setCommitment(c, next)}
                    />
                  </View>
                ))}
              </Card>
            )}
            {completedCommitments.length > 0 ? (
              <CompletedCommitments
                commitments={completedCommitments}
                checkedOf={checkedOf}
                onToggle={setCommitment}
              />
            ) : null}
          </Section>

          {transactions.length > 0 ? <MoneySection profile={profile} /> : null}
          {interactions.length > 0 ? <HistorySection interactions={interactions} /> : null}
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- identity -- */

function IdentityBlock({ profile }: { profile: CrmEntityProfile }) {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const { entity, aliases } = profile;

  const updateContext = useUpdateEntityContext();
  const addAlias = useAddEntityAlias();
  const removeAlias = useRemoveEntityAlias();

  const [contextDraft, setContextDraft] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState<string | null>(null);

  const context = entity.relationshipContext?.trim() ?? '';

  const saveContext = () => {
    const value = contextDraft ?? '';
    setContextDraft(null);
    if (value.trim() === context) return;
    updateContext.mutate(
      { entityId: entity.id, relationshipContext: value },
      {
        onError: (error) =>
          toast.show({ message: 'Could not save that', detail: error.message, tone: 'danger' }),
      },
    );
  };

  const submitAlias = () => {
    const value = (aliasDraft ?? '').trim();
    setAliasDraft(null);
    if (!value) return;
    addAlias.mutate(
      { entityId: entity.id, alias: value },
      {
        onSuccess: () =>
          toast.show({ message: `“${value}” now resolves to ${entity.name}`, tone: 'success' }),
        onError: (error) =>
          toast.show({ message: 'Could not add that alias', detail: error.message, tone: 'danger' }),
      },
    );
  };

  const dropAlias = (alias: string) => {
    removeAlias.mutate(
      { entityId: entity.id, alias },
      {
        onSuccess: () =>
          toast.show({
            message: `Removed “${alias}”`,
            tone: 'neutral',
            action: {
              label: 'Undo',
              onPress: () => addAlias.mutate({ entityId: entity.id, alias }),
            },
          }),
        onError: (error) =>
          toast.show({ message: 'Could not remove that alias', detail: error.message, tone: 'danger' }),
      },
    );
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <Monogram name={entity.name} size={44} />
        <View style={{ flex: 1, gap: 2 }}>
          <Txt variant="title" numberOfLines={1}>
            {entity.name}
          </Txt>
          <Txt variant="micro" tone="tertiary">
            {profile.lastInteractionAt !== null
              ? `last spoke ${formatRelative(profile.lastInteractionAt)}`
              : 'no interactions logged'}
          </Txt>
        </View>
      </View>

      {contextDraft !== null ? (
        <View style={{ gap: spacing.sm }}>
          <Input
            label="Relationship"
            value={contextDraft}
            onChangeText={setContextDraft}
            placeholder="neighbour, CNC shop, sister-in-law…"
            autoFocus
            returnKeyType="done"
            onSubmitEditing={saveContext}
          />
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Button label="Save" variant="primary" size="sm" onPress={saveContext} />
            <Button label="Cancel" variant="ghost" size="sm" onPress={() => setContextDraft(null)} />
          </View>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={context ? `Edit relationship: ${context}` : 'Add relationship context'}
          onPress={() => setContextDraft(context)}
          hitSlop={6}
          style={({ pressed }) => [styles.contextRow, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Ionicons name="pricetag-outline" size={13} color={colors.textTertiary} />
          <Txt variant="caption" tone={context ? 'secondary' : 'tertiary'} style={{ flex: 1 }}>
            {context || 'Add relationship context'}
          </Txt>
          <Ionicons name="create-outline" size={14} color={colors.textTertiary} />
        </Pressable>
      )}

      <View style={styles.aliasRow}>
        {aliases.map((alias) => (
          <Chip key={alias} label={alias} icon="close" size="sm" onPress={() => dropAlias(alias)} />
        ))}
        {aliasDraft === null ? (
          <Chip label="alias" icon="add" size="sm" onPress={() => setAliasDraft('')} />
        ) : null}
      </View>

      {aliasDraft !== null ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm }}>
          <Input
            containerStyle={{ flex: 1 }}
            value={aliasDraft}
            onChangeText={setAliasDraft}
            placeholder="another name you call them"
            autoCapitalize="words"
            autoFocus
            returnKeyType="done"
            onSubmitEditing={submitAlias}
          />
          <Button label="Add" variant="primary" size="md" onPress={submitAlias} />
        </View>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------- commitments -- */

function CommitmentRow({
  commitment,
  checked,
  onToggle,
}: {
  commitment: CrmCommitment;
  checked: boolean;
  onToggle: (next: boolean) => void;
}) {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const task = useTask(commitment.taskId ?? undefined);

  const mine = commitment.direction === 'i_owe';
  const overdue = !checked && commitment.dueDate !== null && commitment.dueDate < Date.now();

  return (
    <View style={{ paddingHorizontal: spacing.md }}>
      <Checkbox checked={checked} onToggle={onToggle} label={commitment.commitmentText} />
      <View style={[styles.metaRow, { gap: spacing.sm, paddingBottom: spacing.sm }]}>
        <Badge label={mine ? 'You owe' : 'They owe'} tone={mine ? 'accent' : 'info'} />
        {commitment.dueDate !== null ? (
          <Txt variant="micro" tone={overdue ? 'danger' : 'tertiary'}>
            {overdue ? 'overdue · ' : 'due '}
            {formatDayHeading(commitment.dueDate)}
          </Txt>
        ) : (
          <Txt variant="micro" tone="tertiary">
            no date
          </Txt>
        )}
        {task.data ? (
          // No task detail route exists yet, so the link lands on the task list.
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open linked task: ${task.data.title}`}
            onPress={() => router.push('/tasks')}
            hitSlop={8}
            style={({ pressed }) => [styles.taskLink, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Ionicons name="git-branch-outline" size={12} color={colors.accent} />
            <Txt variant="micro" tone="accent" numberOfLines={1}>
              {truncate(task.data.title, 28)}
            </Txt>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function CompletedCommitments({
  commitments,
  checkedOf,
  onToggle,
}: {
  commitments: CrmCommitment[];
  checkedOf: (c: CrmCommitment) => boolean;
  onToggle: (c: CrmCommitment, next: boolean) => void;
}) {
  const { colors, spacing } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <View style={{ gap: spacing.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? 'Hide' : 'Show'} ${countLabel(commitments.length, 'closed commitment')}`}
        onPress={() => setOpen((v) => !v)}
        hitSlop={6}
        style={({ pressed }) => [styles.disclosure, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Ionicons
          name={open ? 'chevron-down' : 'chevron-forward'}
          size={13}
          color={colors.textTertiary}
        />
        <Txt variant="micro" tone="tertiary">
          {countLabel(commitments.length, 'closed commitment')}
        </Txt>
      </Pressable>
      {open ? (
        <Card padded={false}>
          {commitments.map((c, i) => (
            <View key={c.id} style={{ paddingHorizontal: spacing.md }}>
              {i > 0 ? <Divider /> : null}
              <Checkbox
                checked={checkedOf(c)}
                onToggle={(next) => onToggle(c, next)}
                label={c.commitmentText}
                sublabel={c.completedAt !== null ? `done ${formatRelative(c.completedAt)}` : undefined}
              />
            </View>
          ))}
        </Card>
      ) : null}
    </View>
  );
}

function CommitmentComposer({ entityName, onDone }: { entityName: string; onDone: () => void }) {
  const { spacing } = useTheme();
  const toast = useToast();
  const add = useAddCommitment();

  const [text, setText] = useState('');
  const [direction, setDirection] = useState<CommitmentDirection>('i_owe');
  const [due, setDue] = useState<DueChoice>('none');

  const submit = () => {
    const commitmentText = text.trim();
    if (!commitmentText) return;
    add.mutate(
      { entityName, commitmentText, direction, dueDate: dueEpoch(due) },
      {
        onSuccess: () => {
          setText('');
          setDue('none');
          onDone();
          toast.show({ message: 'Commitment added', detail: truncate(commitmentText, 60), tone: 'success' });
        },
        onError: (error) =>
          toast.show({ message: 'Could not save that', detail: error.message, tone: 'danger' }),
      },
    );
  };

  return (
    <Card style={{ gap: spacing.sm }}>
      <Input
        label="Commitment"
        value={text}
        onChangeText={setText}
        placeholder={`what was promised with ${entityName}`}
        autoFocus
        multiline
      />
      <Segmented
        value={direction}
        onChange={setDirection}
        options={[
          { value: 'i_owe', label: 'You owe' },
          { value: 'they_owe', label: 'They owe' },
        ]}
      />
      <Segmented
        value={due}
        onChange={setDue}
        options={[
          { value: 'none', label: 'No date' },
          { value: 'today', label: 'Today' },
          { value: 'tomorrow', label: 'Tomorrow' },
          { value: 'week', label: 'In a week' },
        ]}
      />
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Button
          label="Save"
          variant="primary"
          size="sm"
          disabled={!text.trim()}
          loading={add.isPending}
          onPress={submit}
        />
        <Button label="Cancel" variant="ghost" size="sm" onPress={onDone} />
      </View>
    </Card>
  );
}

function InteractionComposer({ entityName, onDone }: { entityName: string; onDone: () => void }) {
  const { spacing } = useTheme();
  const toast = useToast();
  const log = useLogInteraction();
  const [summary, setSummary] = useState('');

  const submit = () => {
    const text = summary.trim();
    if (!text) return;
    log.mutate(
      { entityName, summary: text },
      {
        onSuccess: () => {
          setSummary('');
          onDone();
          toast.show({ message: 'Interaction logged', tone: 'success' });
        },
        onError: (error) =>
          toast.show({ message: 'Could not save that', detail: error.message, tone: 'danger' }),
      },
    );
  };

  return (
    <Card style={{ gap: spacing.sm }}>
      <Input
        label="What happened"
        value={summary}
        onChangeText={setSummary}
        placeholder={`what you and ${entityName} talked about`}
        autoFocus
        multiline
      />
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Button
          label="Log it"
          variant="primary"
          size="sm"
          disabled={!summary.trim()}
          loading={log.isPending}
          onPress={submit}
        />
        <Button label="Cancel" variant="ghost" size="sm" onPress={onDone} />
      </View>
    </Card>
  );
}

/* ------------------------------------------------------------------- money -- */

function MoneySection({ profile }: { profile: CrmEntityProfile }) {
  const { colors, spacing } = useTheme();
  const [showAll, setShowAll] = useState(false);

  const currencies = useMemo(
    () => Object.keys(profile.netByCurrency).sort(),
    [profile.netByCurrency],
  );
  const rows = showAll ? profile.transactions : profile.transactions.slice(0, TX_PREVIEW);
  const hidden = profile.transactions.length - rows.length;

  return (
    <Section title="Money">
      <Card padded={false}>
        {currencies.map((currency, i) => {
          const net = profile.netByCurrency[currency] ?? 0;
          const spent = profile.spentByCurrency[currency] ?? 0;
          const received = profile.receivedByCurrency[currency] ?? 0;
          return (
            <View key={currency}>
              {i > 0 ? <Divider /> : null}
              <View style={[styles.balanceRow, { paddingHorizontal: spacing.md }]}>
                <View style={{ flex: 1, gap: 1 }}>
                  <Txt variant="bodyStrong">{currency}</Txt>
                  <Txt variant="micro" tone="tertiary">
                    out {formatMoney(spent, currency)} · in {formatMoney(received, currency)}
                  </Txt>
                </View>
                <Txt
                  variant="bodyStrong"
                  tone={net > 0 ? 'success' : net < 0 ? 'danger' : 'secondary'}
                >
                  {net >= 0 ? '+' : '-'}
                  {formatMoney(Math.abs(net), currency)}
                </Txt>
              </View>
            </View>
          );
        })}
      </Card>

      <Card padded={false}>
        {rows.map((tx, i) => (
          <View key={tx.id}>
            {i > 0 ? <Divider /> : null}
            <TransactionRow tx={tx} />
          </View>
        ))}
        {hidden > 0 ? (
          <>
            <Divider />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Show ${hidden} older transactions`}
              onPress={() => setShowAll(true)}
              style={({ pressed }) => [styles.moreRow, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Txt variant="micro" tone="accent">
                {`Show ${hidden} older`}
              </Txt>
              <Ionicons name="chevron-down" size={13} color={colors.accent} />
            </Pressable>
          </>
        ) : null}
      </Card>
    </Section>
  );
}

function TransactionRow({ tx }: { tx: Transaction }) {
  const { spacing } = useTheme();
  const income = tx.direction === 'income';
  return (
    <View style={[styles.txRow, { paddingHorizontal: spacing.md, gap: spacing.md }]}>
      <View style={{ flex: 1, gap: 1 }}>
        <Txt variant="body" numberOfLines={1}>
          {tx.description?.trim() || tx.category}
        </Txt>
        <Txt variant="micro" tone="tertiary" numberOfLines={1}>
          {tx.category} · {formatDayHeading(tx.createdAt)}
        </Txt>
      </View>
      <Txt variant="bodyStrong" tone={income ? 'success' : 'primary'}>
        {income ? '+' : '-'}
        {formatMoney(tx.amount, tx.currency)}
      </Txt>
    </View>
  );
}

/* ----------------------------------------------------------------- history -- */

function HistorySection({ interactions }: { interactions: CrmInteraction[] }) {
  const { colors, spacing } = useTheme();
  const [showAll, setShowAll] = useState(false);

  const hidden = showAll ? 0 : Math.max(0, interactions.length - HISTORY_PREVIEW);
  // Already newest-first out of the repository, so a sequential scan groups it.
  const months = useMemo(() => {
    const visible = showAll ? interactions : interactions.slice(0, HISTORY_PREVIEW);
    const out: { key: string; label: string; items: CrmInteraction[] }[] = [];
    for (const item of visible) {
      const at = epochToLocal(item.occurredAt);
      const key = at.toFormat('yyyy-LL');
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(item);
      else out.push({ key, label: at.toFormat('LLLL yyyy'), items: [item] });
    }
    return out;
  }, [interactions, showAll]);

  return (
    <Section title="History">
      {months.map((month) => (
        <View key={month.key} style={{ gap: spacing.xs }}>
          <Txt variant="micro" tone="tertiary" style={{ letterSpacing: 0.6 }}>
            {month.label.toUpperCase()}
          </Txt>
          <Card padded={false}>
            {month.items.map((item, i) => (
              <View key={item.id}>
                {i > 0 ? <Divider /> : null}
                <View style={[styles.historyRow, { paddingHorizontal: spacing.md }]}>
                  <Txt variant="body">{item.summary}</Txt>
                  <Txt variant="micro" tone="tertiary">
                    {formatDayHeading(item.occurredAt)}
                  </Txt>
                </View>
              </View>
            ))}
          </Card>
        </View>
      ))}
      {hidden > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Show ${hidden} older interactions`}
          onPress={() => setShowAll(true)}
          style={({ pressed }) => [styles.disclosure, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Ionicons name="chevron-down" size={13} color={colors.accent} />
          <Txt variant="micro" tone="accent">
            {`Show ${hidden} older`}
          </Txt>
        </Pressable>
      ) : null}
    </Section>
  );
}

/* ------------------------------------------------------------------ pieces -- */

function ScreenHeader({ profile }: { profile: CrmEntityProfile | undefined }) {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  return (
    <View style={[styles.header, { gap: spacing.sm }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to people"
        hitSlop={8}
        // Deep links and notifications can land here with nothing to pop back to.
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/people'))}
        style={({ pressed }) => [styles.back, { opacity: pressed ? 0.5 : 1 }]}
      >
        <Ionicons name="chevron-back" size={24} color={colors.text} />
      </Pressable>
      <Txt variant="micro" tone="tertiary" numberOfLines={1} style={{ flex: 1 }}>
        {profile ? countLabel(profile.interactions.length, 'interaction') : 'People'}
      </Txt>
    </View>
  );
}

function Monogram({ name, size = 34 }: { name: string; size?: number }) {
  const tint = colorForTag(name);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: withAlpha(tint, 0.18),
      }}
    >
      <Txt variant={size >= 44 ? 'heading' : 'caption'} weight="700" style={{ color: tint }}>
        {initialsOf(name)}
      </Txt>
    </View>
  );
}

function MutedRow({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  const { colors, spacing } = useTheme();
  return (
    <View style={[styles.mutedRow, { gap: spacing.sm }]}>
      <Ionicons name={icon} size={14} color={colors.textTertiary} />
      <Txt variant="caption" tone="tertiary">
        {text}
      </Txt>
    </View>
  );
}

function SkeletonBlock() {
  const { colors, spacing, radius } = useTheme();
  const bar = (width: DimensionValue, height: number) => (
    <View
      style={{ width, height, borderRadius: radius.sm, backgroundColor: colors.surfaceSunken }}
    />
  );
  return (
    <View style={{ gap: spacing.md }} importantForAccessibility="no-hide-descendants">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surfaceSunken }} />
        <View style={{ flex: 1, gap: 6 }}>
          {bar('55%', 12)}
          {bar('30%', 9)}
        </View>
      </View>
      <Card style={{ gap: spacing.md }}>
        {bar('80%', 10)}
        {bar('62%', 10)}
        {bar('70%', 10)}
      </Card>
    </View>
  );
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { colors, spacing } = useTheme();
  return (
    <Card accent={colors.danger}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
        <Txt variant="caption" tone="secondary" style={{ flex: 1 }} numberOfLines={3}>
          {message}
        </Txt>
        <Button label="Retry" size="sm" onPress={onRetry} />
      </View>
    </Card>
  );
}

/* ----------------------------------------------------------------- helpers -- */

type DueChoice = 'none' | 'today' | 'tomorrow' | 'week';

/** End of the chosen day: a promise only runs late once that day is over. */
function dueEpoch(choice: DueChoice): number | null {
  if (choice === 'none') return null;
  const days = choice === 'today' ? 0 : choice === 'tomorrow' ? 1 : 7;
  return epochToLocal(Date.now()).plus({ days }).endOf('day').toMillis();
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]![0]!;
  const last = parts.length > 1 ? parts[parts.length - 1]![0]! : '';
  return (first + last).toUpperCase();
}

/** colorForTag returns #RRGGBB; the same hue at low alpha is the plate behind it. */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingTop: 4 },
  back: { width: 32, height: 40, marginLeft: -8, alignItems: 'center', justifyContent: 'center' },
  contextRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 30 },
  aliasRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    paddingLeft: CHECKBOX_INSET,
  },
  taskLink: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 180 },
  disclosure: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 },
  mutedRow: { flexDirection: 'row', alignItems: 'center', minHeight: 32 },
  balanceRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 12 },
  txRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9 },
  historyRow: { paddingVertical: 9, gap: 2 },
  moreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 36 },
});
