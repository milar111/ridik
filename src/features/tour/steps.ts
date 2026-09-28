/**
 * The guided tour, as data.
 *
 * Separated from the overlay that draws it so the copy, the ordering and the
 * routes can be read — and tested — without a renderer.
 *
 * Three things about the shape of this list, all of them learned the hard way.
 *
 * **It walks the app rather than describing it.** The same facts were once
 * three panels of onboarding, and a panel is read once, in a context where
 * nothing on the screen is real. A voice app has no menu, so somebody who has
 * not been shown the Money screen does not know it can take money; they will
 * never guess "spent fifteen forty on lunch" from a microphone and a gradient.
 * So the tour opens each screen in turn and says, in one sentence, what it is
 * for.
 *
 * **Every step shows something.** A tour that lands on an empty Habits screen
 * and says "this is where your habits go" has taught nothing — the reader sees
 * a blank page and a caption. `sample` is the fake: two or three lines of what
 * that screen looks like once it has been used, animated in under the
 * sentence. It is *never* written anywhere and never mixes with real data; it
 * is a picture, drawn in the card.
 *
 * **The copy is spoken, not specified.** Read every line out loud before
 * changing it. "Tap it and say what is happening" is a manual; "Just talk to
 * it — say what's on your mind" is a person. Contractions are correct here.
 *
 * **And the sample may only show what the sentence has already promised.** The
 * focus step is why this is written down: it said "ask for a timer", the reader
 * asked for twenty-five minutes, and the example answered with a five-minute
 * break nobody had mentioned. That reads as the app doing something of its own
 * accord — which is the single worst impression a tour can leave, because the
 * whole product is asking to be trusted with a sentence. Anything the example
 * shows, the body says first.
 *
 * A screen step's `title` is the screen's **name**, matching the menu row and
 * the screen's own heading. The tour reaches every screen *through the menu*
 * now, so those three readings are seen within a second of each other and any
 * disagreement between them is the reader's problem to resolve.
 */

/** A control the spotlight can ring. Only home has these; see `useTourTarget`. */
export type TourTargetId = 'mic' | 'receipt' | 'next-up' | 'menu';

export type TourStep = {
  /** The route this step is about. The tour opens it before drawing the card. */
  route: string;
  /** What to ring, when there is something on this screen worth ringing. */
  target?: TourTargetId;
  title: string;
  body: string;
  /**
   * What this screen looks like once it has been used. Faked on purpose — see
   * the header. First line is usually the phrase you would say; the rest is
   * what comes back.
   */
  sample?: { say?: string; lines: string[] };
  /** Where the card sits when there is no target to sit beside. */
  fallback: 'top' | 'bottom';
};

export const TOUR_STEPS: readonly TourStep[] = [
  {
    route: '/',
    target: 'mic',
    title: 'Just talk to it',
    body: "Press the mic and say what's on your mind, the way you'd say it to a person. Nothing to learn, no forms to fill in.",
    sample: { say: 'dentist Tuesday at three', lines: ['Dentist · Tue 15:00'] },
    fallback: 'bottom',
  },
  {
    route: '/',
    target: 'receipt',
    title: 'You always see what it did',
    // Not "right here": on a first run there is no receipt yet, so there is
    // nothing under the ring to be here. Naming the place works either way.
    body: "Everything Ridik files turns up under the mic, with an Undo beside it. Get one word wrong and it's a single tap to put it back.",
    sample: { lines: ['Added “Dentist” · Tue 15:00', 'Undo'] },
    fallback: 'bottom',
  },
  {
    route: '/',
    target: 'next-up',
    title: "What's next, without asking",
    body: 'The next thing on your day sits at the top of this screen all the time. You never have to go looking for it.',
    fallback: 'top',
  },
  {
    route: '/',
    target: 'menu',
    title: 'And everything else is in here',
    body: "You'll almost never need it — but this is where all of it lives. Let me show you round.",
    fallback: 'top',
  },
  {
    route: '/calendar',
    title: 'Calendar',
    body: "Say when something is and it works out the date. If it's somewhere you have to travel to, it adds the time to get there as well.",
    sample: {
      say: 'exam Thursday at nine in room B12',
      lines: ['Thu 09:00 · Exam · Room B12', 'Leave by 08:30 — 30 min to get there'],
    },
    fallback: 'bottom',
  },
  {
    route: '/tasks',
    title: 'Tasks',
    body: 'Anything with a deadline. Say what something is waiting on and it goes quiet until then, so your list is only what you can actually do.',
    sample: {
      say: "I can't book the hall until Ana confirms",
      lines: ['Book the hall — blocked', 'waiting on: Ana confirms'],
    },
    fallback: 'bottom',
  },
  {
    route: '/notes',
    title: 'Notes',
    body: 'Shopping, packing, anything worth keeping. Name a list and say several things at once — they all land on it.',
    sample: {
      say: 'add milk, bread and coffee to the shopping list',
      lines: ['Shopping · 3 to get', 'milk · bread · coffee'],
    },
    fallback: 'bottom',
  },
  {
    route: '/ledger',
    title: 'Money',
    body: 'Say the amount and what it was for, and it works out the category — lunch goes under Food, so the month adds up without you filing anything. It reads the number back before it records it.',
    sample: {
      say: 'spent fifteen forty on lunch',
      lines: ['€15.40 · Food · today', 'Food this month — €112.80'],
    },
    fallback: 'bottom',
  },
  {
    route: '/habits',
    title: 'Habits',
    body: 'Tell it you did the thing and it counts the run of days for you. No box to tick, nothing to set up first.',
    sample: { say: 'log my run, 5k', lines: ['Running · 5k', '6 days in a row'] },
    fallback: 'bottom',
  },
  {
    route: '/places',
    title: 'Places',
    body: 'Name a place once and Ridik can tap you on the shoulder when you next get there.',
    sample: {
      say: 'remind me to pick up the frame when I get to the lab',
      lines: ['The lab', 'When you arrive: pick up the frame'],
    },
    fallback: 'bottom',
  },
  {
    route: '/people',
    title: 'People',
    body: "Promises are the easiest thing to lose. Mention one in passing and it's kept here, with who and by when.",
    sample: {
      say: 'I promised Ivo the schematic by Friday',
      lines: ['Ivo — send the schematic', 'due Friday'],
    },
    fallback: 'bottom',
  },
  {
    route: '/projects',
    title: 'Projects',
    body: 'A trip, a build, a shoot — anything with parts. Mention the project by name and everything you say about it gathers in one place instead of scattering.',
    sample: {
      say: 'add a tripod to the film project',
      lines: ['Film project', 'tripod — just added', 'lens cloth · spare battery'],
    },
    fallback: 'bottom',
  },
  {
    route: '/focus',
    title: 'Focus',
    body: 'Ask for a timer and you get the breaks with it — twenty-five minutes on, five off, over and over until you stop it. Say the length you want and it works the rest out.',
    sample: {
      say: 'start a 25 minute focus timer',
      lines: ['25:00 — focus', 'then 5 min break, then 25 again'],
    },
    fallback: 'bottom',
  },
  {
    route: '/',
    target: 'mic',
    title: "That's everything",
    body: "There's a timetable, a daily briefing and a week's summary in that menu too. Say one thing now and see what happens — and if you ever forget what to say, it's all under “What to say”.",
    fallback: 'bottom',
  },
];
