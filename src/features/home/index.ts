/**
 * The home screen: a mic, the next thing, and a receipt for the last thing.
 *
 * Everything else in the app is one tap away behind the menu. What lives here
 * had to earn it by answering a question you would otherwise open a screen to
 * ask, or by keeping the voice path honest.
 */
export { HomeMic } from './HomeMic';
export { LastAction } from './LastAction';
export { NextUpLine } from './NextUpLine';
export { HomePanel, HOME_PANEL_MAX_HEIGHT } from './HomePanel';
export { KeptNotes, useKeptNotes, KEPT_NOTES } from './KeptNotes';
export { RecentTurns, useRecentTurns, recentLines, lineFor, type TurnLine } from './RecentTurns';
export { nextUp, type NextUp } from './next';
export { useDailyBriefing } from './useDailyBriefing';
export { lastUndoable, undoableAction, type UndoableAction, type UndoKind } from './undo';
