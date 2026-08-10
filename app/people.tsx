import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { countLabel, joinNatural } from '@/core/format';
import { normalise } from '@/core/match';
import { formatRelative } from '@/core/time';
import { useCrmEntities, useOpenCommitments } from '@/hooks';
import type { CrmEntitySummary } from '@/repositories/crm';
import { Badge, Button, Card, Divider, EmptyState, Input, Screen, Txt } from '@/ui/components';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';
import { colorForTag } from '@/ui/theme';

/** What to say to fill this screen — the empty state is the tutorial. */
const VOICE_HINT = "Try: 'met with Ivo, promised to send him the CAD files by tomorrow evening'";

export default function PeopleScreen() {
  return (
    <Screen>
      <ErrorBoundary
        label="people"
        fallback={(error, reset) => <InlineError message={error.message} onRetry={reset} />}
      >
        <PeopleList />
      </ErrorBoundary>
    </Screen>
  );
}

function PeopleList() {
  const router = useRouter();
  const { spacing } = useTheme();
  const [query, setQuery] = useState('');

  const entities = useCrmEntities();
  const commitments = useOpenCommitments();

  // Recomputed only when the commitment list changes. "Overdue" drifting by a
  // minute is invisible, whereas a live clock would re-render every row.
  const overdueEntityIds = useMemo(() => {
    const at = Date.now();
    const ids = new Set<string>();
    for (const row of commitments.data ?? []) {
      if (row.commitment.dueDate !== null && row.commitment.dueDate < at) ids.add(row.entity.id);
    }
    return ids;
  }, [commitments.data]);

  const all = entities.data ?? [];
  const rows = useMemo(() => {
    const needle = normalise(query);
    if (!needle) return all;
    return all.filter(
      (s) =>
        normalise(s.entity.name).includes(needle) ||
        s.aliases.some((alias) => normalise(alias).includes(needle)),
    );
  }, [all, query]);

  return (
    <>
      <ScreenHeader
        title="People"
        subtitle={all.length > 0 ? countLabel(all.length, 'person', 'people') : undefined}
      />

      {all.length > 0 ? (
        <Input
          value={query}
          onChangeText={setQuery}
          placeholder="Search name or alias"
          accessibilityLabel="Search people"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      ) : null}

      {entities.isPending ? (
        <SkeletonRows />
      ) : entities.isError ? (
        <InlineError
          message={entities.error.message}
          onRetry={() => {
            void entities.refetch();
          }}
        />
      ) : all.length === 0 ? (
        <EmptyState icon="people-outline" title="No one here yet" hint={VOICE_HINT} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="search-outline"
          title={`Nobody matches “${query.trim()}”`}
          hint="Search looks at names and at the aliases you have added."
        />
      ) : (
        <Card padded={false}>
          {rows.map((summary, i) => (
            <View key={summary.entity.id}>
              {i > 0 ? <Divider inset={34 + spacing.md * 2} /> : null}
              <PersonRow
                summary={summary}
                overdue={overdueEntityIds.has(summary.entity.id)}
                onPress={() =>
                  router.push({ pathname: '/person/[id]', params: { id: summary.entity.id } })
                }
              />
            </View>
          ))}
        </Card>
      )}
    </>
  );
}

function PersonRow({
  summary,
  overdue,
  onPress,
}: {
  summary: CrmEntitySummary;
  overdue: boolean;
  onPress: () => void;
}) {
  const { colors, spacing } = useTheme();
  const { entity, aliases, openCommitments, lastInteractionAt } = summary;

  const context = entity.relationshipContext?.trim();
  const meta = context || (aliases.length > 0 ? `aka ${joinNatural(aliases, 'or')}` : '');
  const seen = lastInteractionAt !== null ? formatRelative(lastInteractionAt) : 'no history';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        entity.name,
        meta,
        openCommitments > 0 ? countLabel(openCommitments, 'open commitment') : 'nothing open',
        overdue ? 'overdue' : '',
        `last interaction ${seen}`,
      ]
        .filter(Boolean)
        .join(', ')}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { gap: spacing.md, paddingHorizontal: spacing.md, opacity: pressed ? 0.6 : 1 },
      ]}
    >
      <Monogram name={entity.name} />
      <View style={styles.rowText}>
        <Txt variant="bodyStrong" numberOfLines={1}>
          {entity.name}
        </Txt>
        {meta ? (
          <Txt variant="caption" tone="tertiary" numberOfLines={1}>
            {meta}
          </Txt>
        ) : null}
      </View>
      <View style={styles.rowRight}>
        {openCommitments > 0 ? (
          <Badge label={`${openCommitments} open`} tone={overdue ? 'warning' : 'neutral'} />
        ) : null}
        <Txt variant="micro" tone="tertiary">
          {seen}
        </Txt>
      </View>
      <Ionicons name="chevron-forward" size={15} color={colors.textTertiary} />
    </Pressable>
  );
}

/* ------------------------------------------------------------------ pieces -- */

function ScreenHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  return (
    <View style={[styles.header, { gap: spacing.sm }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back"
        hitSlop={8}
        // Deep links and notifications can land here with nothing to pop back
        // to. Home, not the menu: the menu is a junction you pass through, and
        // sending someone back to it would leave them one more tap from where
        // every route eventually leads anyway.
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        style={({ pressed }) => [styles.back, { opacity: pressed ? 0.5 : 1 }]}
      >
        <Ionicons name="chevron-back" size={24} color={colors.text} />
      </Pressable>
      <View style={{ flex: 1, gap: 1 }}>
        <Txt variant="title">{title}</Txt>
        {subtitle ? (
          <Txt variant="caption" tone="tertiary">
            {subtitle}
          </Txt>
        ) : null}
      </View>
    </View>
  );
}

function Monogram({ name }: { name: string }) {
  const tint = colorForTag(name);
  return (
    <View style={[styles.monogram, { backgroundColor: withAlpha(tint, 0.18) }]}>
      <Txt variant="caption" weight="700" style={{ color: tint }}>
        {initialsOf(name)}
      </Txt>
    </View>
  );
}

function SkeletonRows({ count = 5 }: { count?: number }) {
  const { colors, spacing, radius } = useTheme();
  return (
    <Card padded={false} importantForAccessibility="no-hide-descendants">
      {Array.from({ length: count }, (_, i) => (
        <View key={i}>
          {i > 0 ? <Divider inset={34 + spacing.md * 2} /> : null}
          <View style={[styles.row, { gap: spacing.md, paddingHorizontal: spacing.md }]}>
            <View style={[styles.monogram, { backgroundColor: colors.surfaceSunken }]} />
            <View style={{ flex: 1, gap: 6 }}>
              <View
                style={{ height: 10, width: '52%', borderRadius: radius.sm, backgroundColor: colors.surfaceSunken }}
              />
              <View
                style={{ height: 8, width: '30%', borderRadius: radius.sm, backgroundColor: colors.surfaceSunken }}
              />
            </View>
          </View>
        </View>
      ))}
    </Card>
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

/* ------------------------------------------------------------------ helpers -- */

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
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 56 },
  rowText: { flex: 1, gap: 1 },
  rowRight: { alignItems: 'flex-end', gap: 3 },
  monogram: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
});
