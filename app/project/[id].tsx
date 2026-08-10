/**
 * One project, end to end.
 *
 * This is where the user's own description of the feature has to hold up: "for
 * project X we could do this" lands as an item, "I need to make my luggage, add
 * more slippers" lands as checkboxes in a section, and the tasks, notes, lists
 * and receipts that were filed against the project from anywhere else show up
 * under LINKED. Every mutation goes through the hooks so the tick moves before
 * the write lands.
 */
import { useMemo, useState } from 'react';
import { Alert, InteractionManager, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { countLabel } from '@/core/format';
import type { ProjectItem } from '@/db/schema';
import { copyToClipboard, projectMarkdown, shareAsFile } from '@/features/export';
import {
  AddItemBar,
  ErrorRow,
  LinkedPanel,
  MenuSheet,
  ProjectHeader,
  SectionGroup,
  SkeletonRows,
  STATUS_LABEL,
  UNSECTIONED_TITLE,
  errorMessage,
  swapped,
  type AddItemDraft,
  type MenuOption,
} from '@/features/projects';
import {
  useAddProjectItems,
  useDeleteProject,
  useDeleteProjectItem,
  useMoveProjectItem,
  useProjectOverview,
  useReorderProjectItems,
  useSetProjectStatus,
  useToggleProjectItem,
  useUpdateProjectItem,
} from '@/hooks';
import type { ProjectStatus } from '@/repositories/projects';
import { Button, EmptyState, Screen, Segmented, useToast } from '@/ui/components';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useTheme } from '@/ui/ThemeProvider';

type Tab = 'items' | 'linked';

/** Which menu the single sheet is currently showing. */
type Menu =
  | { kind: 'project' }
  | { kind: 'item'; item: ProjectItem }
  | { kind: 'move'; item: ProjectItem };

const sectionKey = (sectionId: string | null) => sectionId ?? '';

/** `Button`'s padding alone leaves an icon-only ghost at ~37pt. */
const TAP_TARGET = { minWidth: 44, minHeight: 44 } as const;

export default function ProjectDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = typeof id === 'string' ? id : '';

  const { spacing } = useTheme();
  const router = useRouter();
  const toast = useToast();

  const overview = useProjectOverview(projectId);
  const toggleItem = useToggleProjectItem();
  const addItems = useAddProjectItems();
  const updateItem = useUpdateProjectItem();
  const moveItem = useMoveProjectItem();
  const reorderItems = useReorderProjectItems();
  const deleteItem = useDeleteProjectItem();
  const setStatus = useSetProjectStatus();
  const deleteProject = useDeleteProject();

  const [tab, setTab] = useState<Tab>('items');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<Menu | null>(null);
  const [sharing, setSharing] = useState(false);

  const data = overview.data ?? null;
  const sections = useMemo(() => data?.sections ?? [], [data]);
  const sectionTitles = useMemo(
    () =>
      sections
        .map((view) => view.section?.title)
        .filter((title): title is string => title !== undefined),
    [sections],
  );
  const linkedCount = data
    ? data.linked.tasks.length +
      data.linked.notes.length +
      data.linked.checklists.length +
      data.linked.transactions.length
    : 0;

  const complain = (error: unknown) =>
    toast.show({ message: errorMessage(error), tone: 'danger' });

  /* ----------------------------------------------------------------- items */

  const onToggle = (item: ProjectItem, next: boolean) =>
    toggleItem.mutate({ itemId: item.id, completed: next }, { onError: complain });

  const onAdd = (draft: AddItemDraft) =>
    addItems.mutate(
      {
        projectId,
        items: [
          {
            content: draft.content,
            kind: draft.kind,
            isCheckbox: draft.isCheckbox,
            sectionTitle: draft.sectionTitle,
          },
        ],
      },
      { onError: complain },
    );

  /** Reorder is per section, and the repository re-indexes what we send it. */
  const nudge = (item: ProjectItem, delta: number) => {
    const view = sections.find(
      (candidate) => sectionKey(candidate.section?.id ?? null) === sectionKey(item.sectionId),
    );
    if (!view) return;
    const ids = view.items.map((row) => row.id);
    const from = ids.indexOf(item.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    reorderItems.mutate({ projectId, orderedIds: swapped(ids, from, to) }, { onError: complain });
  };

  /**
   * Both confirmations are raised from a menu option, so the sheet is still
   * dismissing when they fire. iOS drops an alert presented mid-dismissal, so
   * the prompt waits for that animation to finish.
   */
  const confirmDeleteItem = (item: ProjectItem) =>
    InteractionManager.runAfterInteractions(() =>
      Alert.alert('Delete this item?', item.content, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteItem.mutate(item.id, { onError: complain }),
        },
      ]),
    );

  /* --------------------------------------------------------------- project */

  const confirmDeleteProject = () => {
    if (!data) return;
    InteractionManager.runAfterInteractions(() =>
      Alert.alert(
        `Delete "${data.project.name}"?`,
        'Its sections and items go with it. Tasks, notes, lists and spending filed against it are kept.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () =>
              deleteProject.mutate(data.project.id, {
                onSuccess: () => router.back(),
                onError: complain,
              }),
          },
        ],
      ),
    );
  };

  const share = async () => {
    if (!data) return;
    setSharing(true);
    try {
      const markdown = projectMarkdown(data);
      const shared = await shareAsFile(markdown, `${data.project.name}.md`, {
        dialogTitle: data.project.name,
      });
      if (shared.ok) return;
      // The document exists either way; only the hand-off failed, so fall back
      // to the clipboard rather than losing the export.
      const copied = await copyToClipboard(markdown);
      toast.show(
        copied.ok
          ? { message: 'Copied this project as markdown', tone: 'success' }
          : { message: shared.error.userMessage, tone: 'danger' },
      );
    } finally {
      setSharing(false);
    }
  };

  /* ----------------------------------------------------------------- menus */

  const projectMenu = (): MenuOption[] => {
    if (!data) return [];
    const current = data.project.status;
    const move = (status: ProjectStatus) => () =>
      setStatus.mutate({ projectId, status }, { onError: complain });
    return [
      { label: 'Mark active', icon: 'play-outline', selected: current === 'active', onPress: move('active') },
      { label: 'Pause', icon: 'pause-outline', selected: current === 'paused', onPress: move('paused') },
      { label: 'Mark done', icon: 'checkmark-done-outline', selected: current === 'done', onPress: move('done') },
      {
        label: 'Archive',
        icon: 'archive-outline',
        selected: current === 'archived',
        onPress: move('archived'),
      },
      { label: 'Share as markdown', icon: 'share-outline', onPress: () => void share() },
      { label: 'Delete project', icon: 'trash-outline', tone: 'danger', onPress: confirmDeleteProject },
    ];
  };

  const itemMenu = (item: ProjectItem): MenuOption[] => {
    const view = sections.find(
      (candidate) => sectionKey(candidate.section?.id ?? null) === sectionKey(item.sectionId),
    );
    const index = view ? view.items.findIndex((row) => row.id === item.id) : -1;
    const last = view ? view.items.length - 1 : -1;
    return [
      {
        label: 'Move up',
        icon: 'arrow-up',
        disabled: index <= 0,
        onPress: () => nudge(item, -1),
      },
      {
        label: 'Move down',
        icon: 'arrow-down',
        disabled: index < 0 || index >= last,
        onPress: () => nudge(item, 1),
      },
      {
        label: item.isCheckbox ? 'Remove the checkbox' : 'Make it a checkbox',
        icon: item.isCheckbox ? 'remove-circle-outline' : 'checkbox-outline',
        onPress: () =>
          updateItem.mutate(
            { itemId: item.id, patch: { isCheckbox: !item.isCheckbox } },
            { onError: complain },
          ),
      },
      {
        label: 'Move to section…',
        icon: 'folder-outline',
        onPress: () => setMenu({ kind: 'move', item }),
      },
      {
        label: 'Delete',
        icon: 'trash-outline',
        tone: 'danger',
        onPress: () => confirmDeleteItem(item),
      },
    ];
  };

  const moveMenu = (item: ProjectItem): MenuOption[] => [
    {
      label: 'No section',
      icon: 'remove-outline',
      selected: item.sectionId === null,
      onPress: () => moveItem.mutate({ itemId: item.id, sectionId: null }, { onError: complain }),
    },
    ...sections
      .map((view) => view.section)
      .filter((section): section is NonNullable<typeof section> => section !== null)
      .map((section) => ({
        label: section.title,
        icon: 'folder-outline' as const,
        selected: item.sectionId === section.id,
        onPress: () =>
          moveItem.mutate({ itemId: item.id, sectionId: section.id }, { onError: complain }),
      })),
  ];

  const menuOptions =
    menu === null
      ? []
      : menu.kind === 'project'
        ? projectMenu()
        : menu.kind === 'item'
          ? itemMenu(menu.item)
          : moveMenu(menu.item);

  /* ---------------------------------------------------------------- render */

  const body = () => {
    // A missing id disables the query, which leaves it `isPending` forever — a
    // skeleton that never resolves. Say what happened instead.
    if (projectId && overview.isPending) {
      return (
        <View style={{ gap: spacing.md }}>
          {/* The back affordance is ours to draw, so it has to exist before the
              data does — a cold open must never be a dead end. */}
          <Button
            icon="chevron-back"
            variant="ghost"
            onPress={() => router.back()}
            accessibilityLabel="Back"
            style={TAP_TARGET}
          />
          <SkeletonRows count={1} height={96} />
          <SkeletonRows count={5} height={44} />
        </View>
      );
    }
    if (overview.isError) {
      return (
        <View style={{ gap: spacing.md }}>
          <Button
            icon="chevron-back"
            variant="ghost"
            onPress={() => router.back()}
            accessibilityLabel="Back"
            style={TAP_TARGET}
          />
          <ErrorRow
            message={errorMessage(overview.error, 'Could not load this project.')}
            onRetry={() => void overview.refetch()}
            busy={overview.isFetching}
          />
        </View>
      );
    }
    if (!data) {
      return (
        <View style={{ gap: spacing.md }}>
          <EmptyState
            icon="help-circle-outline"
            title="This project is gone"
            hint="It was deleted, or the link is stale."
          />
          <Button label="Back" icon="chevron-back" onPress={() => router.back()} />
        </View>
      );
    }

    return (
      <View style={{ gap: spacing.md }}>
        <ProjectHeader
          project={data.project}
          counts={data.counts}
          onBack={() => router.back()}
          onShare={() => void share()}
          onMenu={() => setMenu({ kind: 'project' })}
          sharing={sharing}
        />

        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'items', label: `Items · ${data.counts.total}` },
            { value: 'linked', label: `Linked · ${linkedCount}` },
          ]}
        />

        {tab === 'items' ? (
          <View style={{ gap: spacing.md }}>
            {data.counts.total === 0 ? (
              <EmptyState
                icon="list-outline"
                title="Nothing in this project yet"
                hint={`Say it or type it below. Try: 'for the ${data.project.name}, remind me to pack slippers'`}
              />
            ) : (
              sections.map((view) => {
                const key = sectionKey(view.section?.id ?? null);
                return (
                  <SectionGroup
                    key={key}
                    title={view.section?.title ?? UNSECTIONED_TITLE}
                    items={view.items}
                    collapsed={collapsed.has(key)}
                    onToggleCollapsed={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })
                    }
                    onToggleItem={onToggle}
                    onItemMenu={(item) => setMenu({ kind: 'item', item })}
                  />
                );
              })
            )}

            <AddItemBar
              sections={sectionTitles}
              busy={addItems.isPending}
              onAdd={onAdd}
            />
          </View>
        ) : (
          <LinkedPanel
            linked={data.linked}
            // Typed routes cannot narrow a path built at runtime; every href
            // here comes from this file's own literals.
            onOpen={(href) => router.push(href as never)}
          />
        )}
      </View>
    );
  };

  return (
    <Screen contentStyle={{ paddingTop: spacing.xs }}>
      <ErrorBoundary label="project">{body()}</ErrorBoundary>

      <MenuSheet
        visible={menu !== null}
        title={
          menu === null
            ? undefined
            : menu.kind === 'project'
              ? data?.project.name
              : menu.item.content
        }
        subtitle={
          menu === null
            ? undefined
            : menu.kind === 'project'
              ? data
                ? `${STATUS_LABEL[data.project.status]} · ${countLabel(data.counts.total, 'item')}`
                : undefined
              : menu.kind === 'move'
                ? 'Move to which section?'
                : undefined
        }
        options={menuOptions}
        onClose={() => setMenu(null)}
      />
    </Screen>
  );
}
