/**
 * The home screen: a mic, the next thing, and a receipt for the last thing.
 *
 * Everything else in the app is one tap away behind the menu. What lives here
 * had to earn it by answering a question you would otherwise open a screen to
 * ask, or by keeping the voice path honest.
 */
export { HomeMic } from './HomeMic';
export { HomeExamples } from './HomeExamples';
export { LastAction } from './LastAction';
export {
  buildExamples,
  exampleWindow,
  EXAMPLE_COUNT,
  EXAMPLE_ROTATE_MS,
  type ExampleSources,
} from './examples';
export { NextUpLine } from './NextUpLine';
export { nextUp, type NextUp } from './next';
export { useDailyBriefing } from './useDailyBriefing';
export { lastUndoable, undoableAction, type UndoableAction, type UndoKind } from './undo';
