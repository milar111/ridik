/**
 * "What is coming next, and when do I have to leave for it?"
 *
 * The one question the home screen answers besides listening. Pure and
 * native-free for the same reason `agenda.ts` is: the rules about which item
 * counts as next, and which buffer belongs to it, are worth testing under plain
 * Node rather than through a rendered screen.
 */
import type { Agenda, AgendaItem } from '@/features/today/agenda';

export type NextUp = {
  item: AgendaItem;
  /**
   * When to set off, from the travel/prep block that precedes this item — null
   * when it earned no buffer, which is most things.
   */
  leaveAt: number | null;
};

/**
 * The next thing that has not finished yet, and the buffer that leads to it.
 *
 * Runs off `endsAt`, not `startsAt`: something that began an hour ago and runs
 * for another two is what you are in the middle of, and calling the thing after
 * it "next" would tell you to leave for a meeting you are already sitting in.
 *
 * All-day items are deliberately not eligible. "Next" is a time you have to act
 * on, and an item with no hour attached cannot be one — it would sit there all
 * day claiming to be next while the actual next thing went unmentioned.
 */
export function nextUp(agenda: Agenda, now: number): NextUp | null {
  const upcoming = agenda.timed.filter((item) => item.endsAt > now);

  // Buffers are the answer to "when do I leave", never to "what is next": a
  // travel block is not an appointment, and showing one as the headline would
  // name the journey instead of the thing at the end of it.
  const item = upcoming.find((candidate) => candidate.kind !== 'buffer');
  if (!item) return null;

  // Matched by the title the buffer records, so a buffer whose appointment has
  // already been overtaken by the clock cannot attach itself to a later one
  // that happens to share a start minute.
  const buffer = upcoming.find(
    (candidate) => candidate.kind === 'buffer' && candidate.bufferFor === item.title,
  );

  return { item, leaveAt: buffer ? buffer.startsAt : null };
}
