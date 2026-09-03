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

/** Inset from the right edge of the screen to the mic. */
export const MIC_DOCK_RIGHT = 18;

/**
 * Bottom padding every scrollable screen reserves so its last row is never
 * hidden behind the floating mic.
 */
export const MIC_CLEARANCE = MIC_SIZE + MIC_GAP * 2 + 20;

/**
 * How far in from the right edge nothing *docked* to the bottom may reach.
 *
 * `MIC_CLEARANCE` is the answer for a scrolling screen: the last row can pass
 * under the mic on its way up, so it only has to be able to clear it. A control
 * pinned to the bottom never moves, and the note editor's composer was pinned
 * there with its send button underneath the mic — not clipped, not warned
 * about, just permanently uncoverable by a finger. Eight points of air past the
 * mic's own box.
 */
export const MIC_KEEPOUT = MIC_DOCK_RIGHT + MIC_SIZE + 8;
