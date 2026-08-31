/**
 * The Habits screen's own pieces.
 *
 * The screen still owns the list and the per-habit card; what lives here is the
 * cross-habit summary adopted from the `clay` direction, plus the pure
 * arithmetic behind it.
 */
export { HabitRings, type HabitRingsProps } from './HabitRings';
export { completionRate, formatRate, summarise, type HabitRate } from './rate';
