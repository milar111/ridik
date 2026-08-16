/**
 * Which of the 28 tools this utterance could possibly need.
 *
 * Every call currently offers the model all of them across sixteen domains,
 * while a real utterance touches one domain of two or three. Google's own
 * function-calling guidance is to keep the active set to 10–20; past that the
 * model starts choosing by surface similarity, and a wrong tool pick is not an
 * error message. It is a plausible receipt over the wrong row — this app's
 * defining failure mode, and the one thing `LastAction` exists to catch.
 *
 * The narrowing is spent where it is cheap and refused where it is not:
 *
 *  - **It can say "I don't know", and does so often.** Exactly like
 *    `resolveOne()`, which returns `ambiguous` rather than guessing. `null`
 *    means "offer everything", and every uncertainty resolves to it. A
 *    confident wrong narrowing is worse than no narrowing at all, because the
 *    decoder is *constrained*: a tool that is not in the enum cannot be emitted,
 *    so the model does not fail — it picks the nearest tool that is.
 *  - **Adding a domain is safe; missing one is not.** So the triggers are
 *    deliberately generous and overlapping ("cancel" reaches calendar, tasks
 *    and checklists), and the check that follows is what keeps the set small.
 *  - **Every clause must be explained.** The utterance is split on the
 *    conjunctions that introduce a second instruction, and a clause that
 *    matches no domain at all means we are looking at an intent we did not
 *    recognise — which is precisely when narrowing would drop the tool it
 *    needed. That bails to `null`.
 *
 * `note_create` is in every narrowed set. It is the one tool that cannot lose
 * anything: the offline engine falls back to it for the same reason, and with
 * it present the worst case of a bad narrowing is a note in the user's own
 * words rather than a wrong row in the right-looking place.
 */
import { TOOL_NAMES, type ToolName } from '@/llm/contract';

export type ToolDomain =
  | 'calendar'
  | 'notes'
  | 'tasks'
  | 'habits'
  | 'timer'
  | 'ledger'
  | 'checklists'
  | 'places'
  | 'crm'
  | 'curriculum'
  | 'projects'
  | 'briefing'
  | 'summary'
  | 'search';

/**
 * Every tool, in exactly one domain.
 *
 * Exhaustive on purpose, and asserted so in the tests: a tool that belongs to
 * no domain would be unreachable on every narrowed turn, and nothing else in
 * the app would notice. A new tool must be given a home here or the suite
 * fails.
 */
export const DOMAIN_TOOLS: Record<ToolDomain, readonly ToolName[]> = {
  calendar: ['calendar_add', 'calendar_update', 'calendar_delete'],
  notes: ['note_create', 'note_update', 'note_delete'],
  tasks: ['task_add', 'task_add_dependency', 'task_complete'],
  habits: ['habit_log', 'activity_log'],
  timer: ['timer_start', 'timer_control'],
  ledger: ['ledger_add', 'ledger_query'],
  checklists: ['checklist_add', 'checklist_toggle'],
  places: ['geofence_add', 'place_save'],
  crm: ['crm_add_commitment', 'crm_log_interaction'],
  curriculum: ['curriculum_add'],
  projects: ['project_create', 'project_add_item', 'project_item_toggle'],
  briefing: ['briefing_generate'],
  summary: ['summary_generate'],
  search: ['search'],
};

/**
 * Always offered, whatever the utterance looked like. One tool, and the only
 * one whose failure mode is "the user reads it later and fixes it" rather than
 * "a row the user never sees is wrong".
 */
export const ALWAYS_OFFERED: readonly ToolName[] = ['note_create'];

/**
 * The point at which narrowing stops being worth its own risk.
 *
 * Google's guidance is 10–20 active tools. Getting from 28 to 20 buys little
 * and still risks dropping the one that mattered, so a set that does not come
 * in under this is abandoned in favour of the full surface — the honest answer
 * when an utterance really does span half the app.
 */
export const MAX_NARROWED_TOOLS = 12;

export type PickReason =
  /** Nothing in the utterance named a domain. */
  | 'no_evidence'
  /** Part of the utterance matched nothing, so something is unaccounted for. */
  | 'unexplained_clause'
  /** It genuinely spans too much of the app to narrow safely. */
  | 'too_broad'
  | 'narrowed';

export type ToolPick = {
  /** The tools to offer, or `null` for "I don't know — offer all of them". */
  tools: readonly ToolName[] | null;
  domains: readonly ToolDomain[];
  reason: PickReason;
};

const WIDE = (reason: PickReason, domains: ToolDomain[] = []): ToolPick => ({
  tools: null,
  domains,
  reason,
});

/* ----------------------------------------------------------------- triggers -- */

/**
 * Lowercases and strips everything a word boundary would trip over, so the
 * patterns below can be written as plain words. Apostrophes go rather than
 * becoming breaks, the same way `classifyConfirmation` treats them: "what's"
 * has to stay one token or "whats my day" never matches.
 *
 * The comma and the semicolon are **kept**, and that is not cosmetic:
 * `pickTools` normalises before it splits, so stripping them here deleted the
 * `,` and `;` alternatives out of `CLAUSE_BREAK` before the split ever saw
 * them. "Remind me about the dentist tomorrow, put the drill back in the van"
 * came through as one clause and was judged fully explained by the half of it
 * we understood — which is the precise failure `unexplained_clause` exists to
 * catch. They are punctuation to the triggers either way: every pattern below
 * is anchored on `\b`, and a comma is a word boundary.
 */
export function normaliseUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s:,;]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TIME_OF_DAY =
  /\b(?:\d{1,2}:\d{2}|\d{1,2} ?(?:am|pm)|oclock|noon|midday|midnight|tonight|tomorrow|today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|morning|afternoon|evening|next week|this week|next month)\b/;

/**
 * One pattern per domain. Generous by design — a domain that is added when it
 * was not needed costs two or three tokens of enum; a domain that is missed
 * costs the user a wrong row.
 */
const TRIGGERS: Record<ToolDomain, RegExp> = {
  calendar:
    /\b(?:remind|reminder|reminders|appointment|appointments|meeting|meetings|calendar|event|events|exam|exams|schedule|scheduled|reschedule|book|booked|booking|cancel|cancelled|postpone|move|moved|push back|homework|due|deadline|all day|busy)\b|__TIME__/,
  notes: /\b(?:note|notes|noted|jot|memo|write down|wrote down|writing down|remember that|make a note)\b/,
  tasks:
    /\b(?:task|tasks|todo|todos|to do|deadline|due|blocked|blocking|blocks|depends|depend|dependency|prerequisite|until|need to|needs to|have to|has to|got to|must|finish|finished|complete|completed|done with|tick off|cross off|mark)\b/,
  // `activity_log` lives here, and it is the "I did a thing" catch-all — so a
  // duration counts as evidence. Without it "spent two hours on the firmware"
  // matches only the money domain, and a report of *time* is decoded against a
  // tool that writes a *transaction*.
  //
  // A time of day counts for exactly the same reason, and it has to, because
  // the calendar claims one too. "Vacuumed the flat today" names no domain but
  // `today`, which narrowed to the calendar alone and *deleted* `activity_log`
  // from the enum — leaving `calendar_add` as the only write the decoder could
  // reach and a future agenda event titled "Vacuumed the flat" as the receipt.
  // The same three words without "today" offered all 28 tools and filed it
  // correctly. Whatever a bare time word is evidence of, it is at least as much
  // evidence of a thing that happened at that time as of a thing scheduled for
  // it, so both domains answer to it and the model picks between them.
  habits:
    /\b(?:habit|habits|streak|streaks|ran|run|running|jog|jogged|walk|walked|workout|work out|worked out|exercise|exercised|gym|meditate|meditated|meditation|practise|practised|practice|practiced|swim|swam|cycled|cycling|pushups|steps|drank|log|logged|did my|hour|hours|minute|minutes|mins)\b|__TIME__/,
  timer:
    /\b(?:timer|timers|pomodoro|focus|session|sessions|stopwatch|countdown|pause|paused|resume|skip|break)\b/,
  ledger:
    /\b(?:spent|spend|spending|paid|pay|paying|cost|costs|bought|buy|purchase|purchased|earned|income|expense|expenses|budget|invoice|bill|refund|how much|euro|euros|eur|dollar|dollars|usd|pound|pounds|gbp|lev|leva|bgn)\b/,
  // Three domains own a "that one is done now" tool — a task, a checklist item
  // and a project item — and the user says the same words for all three. They
  // therefore all answer to the same verbs; whichever row it is, the model can
  // reach the right tool for it.
  checklists:
    /\b(?:list|lists|shopping|groceries|grocery|basket|trolley|cart|check off|tick off|cross off|pack|packing|mark|done|complete|completed|finished|got)\b/,
  places:
    /\b(?:geofence|place|places|location|address|coordinates|latitude|longitude|when i (?:get to|arrive|reach|leave|am at|get home)|when im (?:at|near)|next time im)\b/,
  crm: /\b(?:promised|promise|promises|owe|owes|owed|call|called|calling|text|texted|email|emailed|met|meet with|meeting with|spoke|speak to|talked|talk to|told|birthday|contact|contacts|catch up with|introduce)\b/,
  // Two weekdays in one breath is a timetable being dictated, whatever words
  // surround them: "physics Monday at 8, maths Tuesday at 9" names no class and
  // no timetable, and read as a calendar it becomes two one-off events that
  // never repeat.
  curriculum:
    /\b(?:timetable|curriculum|class|classes|lesson|lessons|semester|term|teacher|periods|school schedule|every (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s)\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
  projects:
    /\b(?:project|projects|trip|trips|for my|milestone|milestones|section|sprint|initiative|mark|done|complete|completed|finished)\b/,
  briefing:
    /\b(?:briefing|brief me|rundown|agenda|whats on|what is on|whats my day|what do i have|what have i got|catch me up|whats next|read me)\b/,
  summary: /\b(?:summary|summarise|summarize|summarised|recap|report|export|how did (?:my|the) (?:day|week|month) go|review of)\b/,
  search: /\b(?:search|find|look up|looking for|where is|where did|do i have|did i|whens my|when is my)\b/,
};

const DOMAINS = Object.keys(TRIGGERS) as ToolDomain[];

function matches(domain: ToolDomain, text: string): boolean {
  const pattern = TRIGGERS[domain];
  if (pattern.source.includes('__TIME__')) {
    return new RegExp(pattern.source.replace('__TIME__', TIME_OF_DAY.source)).test(text);
  }
  return pattern.test(text);
}

/**
 * Where one instruction stops and the next begins.
 *
 * The same rule the offline engine uses to stop a spend category swallowing the
 * rest of the sentence: a conjunction or a comma only starts a new clause when
 * what follows is unmistakably a new instruction — a subject and a verb, or an
 * imperative. A bare noun phrase after "and" is still part of the same one, or
 * "add milk, eggs and bread to the shopping list" becomes three clauses, two of
 * which explain nothing and would bail every list the user ever dictates.
 */
const CLAUSE_BREAK =
  /\s*(?:,|;|\band\b|\bthen\b|\balso\b|\bplus\b)\s+(?=(?:i|we|you|he|she|they)\s+\w|(?:add|remind|note|log|start|stop|book|schedule|cancel|delete|remove|move|create|make|put|set|call|text|email|find|search|show|tell|check|mark|pay|buy|spend|track|plan|log)\b)/;

export function splitClauses(text: string): string[] {
  return text
    .split(CLAUSE_BREAK)
    // A break taken on a conjunction can leave the comma that preceded it
    // hanging off the end of the clause before ("remind me at 4, and call
    // ivo"). Harmless to the triggers, ugly in a log line.
    .map((clause) => clause.replace(/^[,;\s]+|[,;\s]+$/g, ''))
    .filter((clause) => clause.length > 0);
}

/* ------------------------------------------------------------------- picker -- */

/**
 * The active tool set for one utterance.
 *
 * Pure, and deliberately dull: no clock, no repositories, no model. It reads
 * only the words, and it prefers to hand back `null`.
 */
export function pickTools(transcript: string): ToolPick {
  const text = normaliseUtterance(transcript);
  if (!text) return WIDE('no_evidence');

  const domains = new Set<ToolDomain>();
  let unexplained = false;

  for (const clause of splitClauses(text)) {
    const found = DOMAINS.filter((domain) => matches(domain, clause));
    if (found.length === 0) unexplained = true;
    for (const domain of found) domains.add(domain);
  }

  const ordered = DOMAINS.filter((domain) => domains.has(domain));
  if (ordered.length === 0) return WIDE('no_evidence');
  // A clause nobody claims is an intent we did not recognise, and narrowing
  // now would be narrowing around only the half of the sentence we understood
  // — which is the exact shape of the mistake this is meant to prevent.
  if (unexplained) return WIDE('unexplained_clause', ordered);
  const tools = new Set<ToolName>(ALWAYS_OFFERED);
  for (const domain of ordered) for (const tool of DOMAIN_TOOLS[domain]) tools.add(tool);

  if (tools.size > MAX_NARROWED_TOOLS) return WIDE('too_broad', ordered);

  // Contract order, always: the schema branches and the prompt's tool list are
  // both written in it, and a set whose order wandered per utterance would make
  // two identical turns produce two different requests.
  return {
    tools: TOOL_NAMES.filter((name) => tools.has(name)),
    domains: ordered,
    reason: 'narrowed',
  };
}
