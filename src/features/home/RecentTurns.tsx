/**
 * The rest of the conversation — one of the two things the home panel can show.
 *
 * `LastAction` reports one turn and then that turn is gone, replaced by the
 * next one and recoverable only from a debug trail behind the menu. That is
 * fine for a single command and wrong for the way people actually talk: three
 * or four sentences in a row, each depending on the last, with the answer to
 * "did that land where I meant?" scrolled away by the time the thought is
 * finished.
 *
 * ## What it shows is exactly what the model was given
 *
 * The window is `RECALL_WINDOW_MS` and `RECALL_TURNS` — the same two constants
 * `src/llm/recall.ts` uses to decide what travels with the next utterance. That
 * is the whole design and not a coincidence: **what the user can see is what
 * the model can see.** A fragment like "toilet paper" only works because the
 * turn above it is still in play, and the honest way to show that is to put the
 * turn above it on the screen. When the window lapses, both go at once — the
 * model stops carrying the conversation and the screen stops claiming there is
 * one.
 *
 * ## Two things it deliberately is not
 *
 * **The newest turn is not here.** It is in `LastAction`, below the panel, with
 * the tick, the undo and the announcement. Drawn twice it would be a receipt
 * above a receipt, the upper one with no undo — so the row matching the live
 * outcome is dropped, and only the newest one, because saying the same sentence
 * twice in an evening is a thing people do and both times count.
 *
 * **Nothing here is tappable.** The obvious next move is to route each line to
 * what it wrote, and there is nothing honest to route to: the audit row keeps
 * the parameters the model *sent*, not the href the executor computed, and
 * deriving a route from a tool name is how a tap lands on the one screen the
 * row is not on — the same defect that sent a blocked task's receipt to
 * `/tasks`. This is a record of what was said and what came of it. The turn
 * that still has somewhere to go is the one below, which has the href the
 * executor actually returned.
 *
 * The panel chrome — the ground, the radius, the bounded height — belongs to
 * `HomePanel`, which is shared with the notes pane. The reason it is painted at
 * all is measured and written up there.
 */
import { useEffect } from 'react';
import { View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { now } from '@/core/clock';
import { useVoiceStore } from '@/features/voice/store';
import { useInteractionHistory } from '@/hooks';
import { qk } from '@/hooks/keys';
import { RECALL_TURNS, RECALL_WINDOW_MS } from '@/llm/recall';
import type { Interaction } from '@/repositories/llmInteractions';
import { useTheme } from '@/ui/ThemeProvider';
import { Txt } from '@/ui/components/Text';

export type TurnLine = {
  key: string;
  /** The user's own words. Never presented as the app's sentence. */
  said: string;
  /** What came of them, as the executor summarised it. */
  did: string;
};

/**
 * One turn as two lines, or nothing.
 *
 * The order is what the turn actually produced, then what it asked, then what
 * it said — because a row that was written is the only one of the three the
 * user might need to correct. A turn that failed says so plainly rather than
 * being dressed up as a result.
 */
export function lineFor(row: Interaction): TurnLine | null {
  const said = row.transcript.trim().replace(/\s+/g, ' ');
  if (said === '') return null;

  const applied = row.parsedActions.filter((action) => action.ok && action.summary);
  const asked = row.parsedActions.find((action) => action.asked);

  const did =
    applied.length > 0
      ? applied[applied.length - 1]!.summary! +
        (applied.length > 1 ? `, and ${applied.length - 1} more` : '')
      : (asked?.asked ??
        row.feedback?.trim() ??
        (row.status === 'error' ? 'That one did not land.' : ''));

  return did === '' ? null : { key: row.id, said, did };
}

/** The turns still inside the window, oldest first, minus the live one. */
export function recentLines(
  rows: readonly Interaction[],
  options: { at: number; liveTranscript?: string | undefined },
): TurnLine[] {
  const floor = options.at - RECALL_WINDOW_MS;
  const live = options.liveTranscript?.trim();
  const withoutLive =
    live !== undefined && rows[0]?.transcript.trim() === live ? rows.slice(1) : rows;

  return withoutLive
    .filter((row) => row.createdAt >= floor)
    .slice(0, RECALL_TURNS)
    .map(lineFor)
    .filter((line): line is TurnLine => line !== null)
    // Oldest first: the column reads downwards into the live receipt below it.
    .reverse();
}

/**
 * The conversation as the panel needs it.
 *
 * A hook rather than fetching inside the view, because `HomePanel` has to know
 * whether this side has anything *before* it decides which side to open on and
 * whether a toggle is worth drawing at all.
 */
export function useRecentTurns(): TurnLine[] {
  const queryClient = useQueryClient();
  const outcome = useVoiceStore((s) => s.outcome);
  const { data } = useInteractionHistory({ limit: RECALL_TURNS + 1 });

  /*
   * `VoiceDock` invalidates every query when a turn *writes* something, which
   * covers most turns and not all of them: a question answered from context
   * writes no row, so without this the trail would silently skip it and the
   * screen would disagree with what the model was given. Keyed on the outcome
   * object rather than on its contents — a new turn is a new object.
   */
  useEffect(() => {
    if (outcome) void queryClient.invalidateQueries({ queryKey: qk.history.all });
  }, [outcome, queryClient]);

  return recentLines(data ?? [], { at: now(), liveTranscript: outcome?.transcript });
}

/** The rows themselves. The panel around them is `HomePanel`. */
export function RecentTurns({ lines }: { lines: readonly TurnLine[] }) {
  const { colors, spacing } = useTheme();

  return (
    <>
      {lines.map((line) => (
        <View
          key={line.key}
          accessibilityLabel={`You said ${line.said}. ${line.did}`}
          style={{
            borderLeftWidth: 2,
            borderLeftColor: colors.border,
            paddingLeft: spacing.sm,
            gap: 2,
          }}
        >
          <Txt variant="micro" tone="tertiary" numberOfLines={1}>
            {`“${line.said}”`}
          </Txt>
          <Txt variant="caption" tone="secondary" numberOfLines={2}>
            {line.did}
          </Txt>
        </View>
      ))}
    </>
  );
}
