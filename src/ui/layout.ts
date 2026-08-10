/**
 * Chrome dimensions shared by the floating mic and every screen's bottom
 * padding. They live apart from both so the dock does not have to import the
 * layout that renders it.
 *
 * There is no tab bar constant any more: the five-tab bar was replaced by the
 * menu, and the mic now sits on the safe area itself.
 */

/** Gap between the safe area and the mic button. */
export const MIC_GAP = 12;

/** Mic button diameter. */
export const MIC_SIZE = 60;

/**
 * Bottom padding every scrollable screen reserves so its last row is never
 * hidden behind the floating mic.
 */
export const MIC_CLEARANCE = MIC_SIZE + MIC_GAP * 2 + 20;
