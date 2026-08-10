/**
 * Chrome dimensions shared by the tab bar, the floating mic and every screen's
 * bottom padding. They live apart from both so the dock does not have to import
 * the layout that renders it.
 */

/** Tab bar height excluding the safe-area inset. */
export const TAB_BAR_CONTENT_HEIGHT = 58;

/** Gap between the tab bar and the mic button. */
export const MIC_GAP = 12;

/** Mic button diameter. */
export const MIC_SIZE = 60;

/**
 * Bottom padding every scrollable screen reserves so its last row is never
 * hidden behind the floating mic.
 */
export const MIC_CLEARANCE = MIC_SIZE + MIC_GAP * 2 + 20;
