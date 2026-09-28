/**
 * What you can say, in the words you would say it.
 *
 * The discoverability problem this exists for is specific and expensive: a
 * voice app has no menu, so a new user's only way to find out what works is to
 * guess — and every guess is a request, billed against a *lifetime* trial on a
 * free install. Somebody learning the app by experiment pays for the lesson.
 *
 * Two rules, both of which are easy to break and both of which make this worse
 * than nothing when broken.
 *
 * **Every line here must be a thing the app can actually do.** These are read
 * as promises, and a promise the assistant answers with "I could not do that"
 * is worse than never having offered it — the user does not conclude that one
 * phrase is unsupported, they conclude the app is unreliable. So each entry
 * names the tool it exercises, and `phrases.test.ts` checks that name against
 * `TOOL_NAMES` in the contract. A tool renamed or removed fails the test rather
 * than silently turning this screen into a list of lies.
 *
 * **And the gaps are stated, not hidden.** `note` on a group is where "you
 * cannot do the opposite of this yet" goes. A reference screen that lists only
 * what works teaches the user that everything works, and the first thing they
 * try that does not is the thing they remember.
 */
import type { ToolName } from '@/llm/contract';

export type Phrase = {
  /** Said out loud, in lower case, exactly as somebody would say it. */
  say: string;
  /** The tool it reaches. Checked against the contract by the test. */
  tool: ToolName;
};

export type PhraseGroup = {
  key: string;
  icon: string;
  title: string;
  /** One line on what this group is for. Not a feature list. */
  blurb: string;
  phrases: Phrase[];
  /** An honest limit, where one exists. Rendered quietly under the examples. */
  note?: string;
};

export const PHRASE_GROUPS: PhraseGroup[] = [
  {
    key: 'calendar',
    icon: 'calendar-outline',
    title: 'Your calendar',
    blurb: 'Say when something is and Ridik works out the date, the length and the travel time.',
    phrases: [
      { say: 'dentist Tuesday at 3 at the clinic', tool: 'calendar_add' },
      { say: 'move the dentist to Wednesday', tool: 'calendar_update' },
      { say: 'cancel the dentist', tool: 'calendar_delete' },
    ],
  },
  {
    key: 'tasks',
    icon: 'checkbox-outline',
    title: 'Things to do',
    blurb: 'Anything with a deadline, and anything that has to wait for something else.',
    phrases: [
      { say: 'remind me to renew the car insurance on Friday', tool: 'task_add' },
      { say: 'move the car insurance to next Tuesday', tool: 'task_update' },
      { say: 'mark the car insurance done', tool: 'task_complete' },
      { say: 'delete the car insurance task', tool: 'task_delete' },
      { say: "I can't book the hall until Ana confirms", tool: 'task_add_dependency' },
    ],
    note: 'Done and deleted are different: only done counts towards your day.',
  },
  {
    key: 'lists',
    icon: 'list-outline',
    title: 'Lists',
    blurb: 'Shopping, packing, anything with items. Say several at once.',
    phrases: [
      { say: 'add milk, bread and coffee to the shopping list', tool: 'checklist_add' },
      { say: 'tick off the milk', tool: 'checklist_toggle' },
      { say: 'take the coffee off the shopping list', tool: 'checklist_remove' },
      { say: 'delete the shopping list', tool: 'checklist_delete' },
    ],
    note: 'Ticking off keeps it; taking it off removes it. Deleting a whole list asks first.',
  },
  {
    key: 'money',
    icon: 'wallet-outline',
    title: 'What you spent',
    blurb: 'Say the amount and what it was for. Ridik files the category.',
    phrases: [
      { say: 'spent fifteen forty on lunch', tool: 'ledger_add' },
      { say: 'how much have I spent on coffee this month', tool: 'ledger_query' },
      { say: 'delete that last expense', tool: 'ledger_delete' },
    ],
    note: 'Ridik always reads an amount back before recording it.',
  },
  {
    key: 'notes',
    icon: 'document-text-outline',
    title: 'Notes and finding things',
    blurb: 'Anything worth keeping, and one way to get it back.',
    phrases: [
      { say: 'note the wifi password is hunter2 dash lab', tool: 'note_create' },
      { say: 'add the router IP to the wifi note', tool: 'note_update' },
      { say: 'find the wifi password', tool: 'search' },
      { say: 'delete the wifi note', tool: 'note_delete' },
    ],
  },
  {
    key: 'habits',
    icon: 'flame-outline',
    title: 'Habits',
    blurb: 'Say you did it. Ridik keeps the streak.',
    phrases: [{ say: 'log my run, 5k', tool: 'habit_log' }],
  },
  {
    key: 'projects',
    icon: 'albums-outline',
    title: 'Projects',
    blurb: 'Anything with parts — a trip, a build, a shoot.',
    phrases: [
      { say: 'add a tripod to the film project', tool: 'project_add_item' },
      { say: 'tick off the tripod', tool: 'project_item_toggle' },
    ],
  },
  {
    key: 'day',
    icon: 'sunny-outline',
    title: 'Your day',
    blurb: 'Ask rather than tell.',
    phrases: [
      { say: 'what does my day look like', tool: 'briefing_generate' },
      { say: 'start a 25 minute focus timer', tool: 'timer_start' },
    ],
  },
];

/**
 * The four things somebody has to know to use this without fear.
 *
 * Not phrases, which is why they are not in the catalogue above: they answer
 * "what happens if it gets it wrong", and that question is the one that stops
 * people speaking at all. A voice app that has never told you what it does with
 * a mis-heard word gets short, careful, low-value sentences — which is the
 * failure mode, not a wrong row.
 *
 * Each of these is a real mechanism and not reassurance: the review composer
 * (`store.ts`), the confirmation gate (`llm/confirm.ts`), `LastAction`'s undo
 * allow-list, and the offline matcher. If one is ever removed, the sentence
 * about it has to go with it.
 */
export const SAFETY_POINTS: readonly string[] = [
  'Nothing is sent until you have seen the words. Ridik shows you what it heard, and you can fix it before it goes.',
  'Anything that spends money or deletes something asks first, with the details in the question.',
  'The last thing it did stays on the home screen with an Undo next to it.',
  'No signal is fine. Ridik still files what you said, and tells you it was working offline.',
];
