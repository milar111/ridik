/**
 * One voice turn, end to end.
 *
 * Everything between "the user stopped talking" and "the app says something
 * back" lives here: gather context, ask the model, apply what it decided, and
 * compose one sentence about it. Three properties the callers depend on:
 *
 *  - **Every turn is audited.** A row lands in `llm_interactions` whether the
 *    turn succeeded, asked a question or fell over, because a voice bug the
 *    user cannot reproduce is only debuggable from the transcript plus the raw
 *    reply. Failing to write that row must never fail the turn.
 *  - **A question is a turn, not a dead end.** Both kinds of question — the
 *    model asking for a missing parameter, and the executor refusing to guess
 *    or to overwrite — come back as one `clarification` the dock can answer,
 *    with enough state in `pending` to finish the job on the next turn.
 *  - **Yes and no cost nothing.** A follow-up that is plainly an affirmation or
 *    a refusal is applied locally: re-asking the model would spend a second
 *    round trip to be told what we already decided, and could resolve the fuzzy
 *    reference differently the second time.
 */
import { z } from 'zod';

import { now as readClock } from '@/core/clock';
import { countLabel } from '@/core/format';
import type { Logger } from '@/core/logger';
import { currentZone } from '@/core/time';
import { newId } from '@/db/ids';
import { llmInteractions } from '@/db/schema';
import type { LlmClient } from '@/llm/client';
import { actionSchema, type LlmAction, type ToolName } from '@/llm/contract';
import type { ConfirmMode } from './confirm';
import { buildLlmContext } from '@/llm/context';
import { createExecutor, type ActionResult, type ExecutorEffects } from '@/llm/executor';
import type { LlmMessage } from '@/llm/provider';
import type { Repositories } from '@/repositories';

/* --------------------------------------------------------------- contract -- */

/** Structurally the `VoiceOutcomeItem` the dock renders, without the store dependency. */
export type TurnItem = {
  toolName: ToolName;
  ok: boolean;
  summary: string;
  detail?: string;
  href?: string;
  /**
   * The row the action touched. Carried so the UI can offer to undo a create;
   * what it points at differs per tool, which is why `undoableAction` decides
   * rather than the caller — `habit_log` reports the *habit*, not the entry.
   */
  entityId?: string;
};

/** Structurally `VoiceOutcome` from '@/features/voice/store'. */
export type TurnOutcome = {
  /** Present only when a provider was actually called; feeds the spend meter. */
  usage?: { model: string; inputTokens?: number | undefined; outputTokens?: number | undefined };
  /**
   * False when every result asked to stay quiet — a briefing the user tapped
   * for rather than spoke for. The dock still shows it; TTS skips it.
   */
  speak?: boolean;
  transcript: string;
  feedback?: string;
  items: TurnItem[];
  clarification?: { question: string; pending?: string };
};

export type TurnInput = {
  transcript: string;
  /** Recogniser confidence, `null` when the engine reported none. Audited as-is. */
  confidence?: number | null;
  /** The `pending` from the previous turn's clarification, echoed back by the UI. */
  pending?: string;
  signal?: AbortSignal;
};

export type OrchestratorOptions = {
  repos: Repositories;
  client: Pick<LlmClient, 'interpret'>;
  effects?: ExecutorEffects;
  zone?: string;
  logger?: Logger;
  /**
   * How much the assistant shows before it writes — the user's Settings
   * choice, threaded through rather than read here, because this module is
   * pure and the setting lives behind a hook.
   *
   * Omitted means no review gate. The *product* default is
   * `DEFAULT_CONFIRM_MODE` and the pipeline passes it; a caller that has not
   * thought about the policy gets the old behaviour rather than a surprise
   * question it has no surface to answer.
   */
  confirmMode?: ConfirmMode;
};

/** Roughly one breath of speech; longer and the user has stopped listening. */
export const FEEDBACK_WORD_CAP = 25;

/* ------------------------------------------------------------ confirmation -- */

/**
 * Plain yes and no, and nothing else.
 *
 * A prefix match is not enough: "book it" is an answer but "book it for
 * Friday" is a new instruction, and treating the second as the first would
 * apply the parked action while silently dropping the correction. So *every*
 * word has to belong to the vocabulary, and at least one has to carry the
 * verdict. Negations are tested first because several of them contain an
 * affirmative word ("don't book it").
 */
const YES_MARKERS = [
  'y', 'ye', 'yes', 'yeah', 'yep', 'yup', 'yah', 'aye', 'ok', 'okay', 'k', 'sure', 'fine',
  'correct', 'right', 'confirm', 'confirmed', 'affirmative', 'absolutely', 'definitely',
  'certainly', 'indeed', 'agreed', 'course', 'ahead', 'proceed', 'good', 'great', 'perfect',
  'do', 'book', 'go',
];
const YES_FILLERS = [
  'it', 'that', 'this', 'them', 'and', 'then', 'please', 'thanks', 'thank', 'you', 'for', 'of',
  'on', 'now', 'sounds', 'well', 'all', 'im', 'thats',
];

const NO_MARKERS = [
  'n', 'no', 'nope', 'nah', 'naw', 'negative', 'not', 'dont', 'doesnt', 'cancel', 'stop', 'skip',
  'forget', 'leave', 'never', 'nevermind', 'abort', 'drop', 'scrap', 'undo',
];
const NO_FILLERS = [
  'it', 'that', 'this', 'them', 'mind', 'thanks', 'thank', 'you', 'please', 'and', 'then', 'now',
  'do', 'book', 'go', 'worry', 'about', 'for', 'im', 'thats',
];

const YES = { markers: new Set(YES_MARKERS), words: new Set([...YES_MARKERS, ...YES_FILLERS]) };
const NO = { markers: new Set(NO_MARKERS), words: new Set([...NO_MARKERS, ...NO_FILLERS]) };

/** Longer than this and it is an instruction, whatever word it opens with. */
const CONFIRMATION_WORD_CAP = 6;

export type Confirmation = 'yes' | 'no' | 'other';

export function classifyConfirmation(text: string): Confirmation {
  const tokens = text
    .toLowerCase()
    // Apostrophes go rather than becoming word breaks, so "don't" stays one word.
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0 || tokens.length > CONFIRMATION_WORD_CAP) return 'other';
  if (matches(tokens, NO)) return 'no';
  if (matches(tokens, YES)) return 'yes';
  return 'other';
}

function matches(tokens: string[], vocabulary: { markers: Set<string>; words: Set<string> }): boolean {
  return (
    tokens.every((token) => vocabulary.words.has(token)) &&
    tokens.some((token) => vocabulary.markers.has(token))
  );
}

/* ---------------------------------------------------------------- pending -- */

/**
 * What a clarification carries across the gap between two turns.
 *
 * The actions are stored whole rather than as an id or an index: by the time
 * the user answers, the utterance that produced them is gone, and resolving
 * "the meeting with Ivo" a second time could legitimately land on a different
 * row than the one the question was asked about.
 */
const pendingSchema = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    kind: z.literal('confirm'),
    question: z.string(),
    transcript: z.string(),
    actions: z.array(actionSchema).min(1),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal('clarify'),
    question: z.string(),
    transcript: z.string(),
    hint: z.string().optional(),
  }),
]);

export type PendingState = z.infer<typeof pendingSchema>;

export function encodePending(state: PendingState): string {
  return JSON.stringify(state);
}

/** Anything we did not write — including the model's own free-text `pending` — is null. */
export function parsePending(raw: string | undefined): PendingState | null {
  if (!raw) return null;
  try {
    const parsed = pendingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------- orchestrator -- */

type AuditRow = {
  transcript: string;
  confidence: number | null;
  raw: string | null;
  results: { action: LlmAction | null; result: ActionResult }[];
  feedback: string | null;
  status: 'ok' | 'clarify' | 'error';
  error: string | null;
  latencyMs: number;
  model: string | null;
};

/**
 * A turn stays silent only when every result asked to. One spoken confirmation
 * in a batch is enough reason to read the whole reply out.
 */
function shouldSpeak(results: readonly ActionResult[]): boolean {
  return results.length === 0 || !results.every((result) => result.silent === true);
}

export function createOrchestrator(options: OrchestratorOptions) {
  const { repos, client, logger } = options;
  const zone = options.zone ?? currentZone();

  /**
   * The audit trail is diagnostics, not data: a table that is momentarily
   * unhappy must not turn a turn the user just watched succeed into an error.
   */
  async function audit(row: AuditRow): Promise<void> {
    try {
      await repos.db.insert(llmInteractions).values({
        id: newId(),
        transcript: row.transcript,
        confidence: row.confidence,
        rawResponse: row.raw,
        actions: JSON.stringify(
          row.results.map(({ action, result }) => ({
            tool_name: result.toolName,
            parameters: action?.parameters ?? null,
            ok: result.ok,
            summary: result.summary,
            ...(result.error ? { error: result.error.code } : {}),
            ...(result.needsConfirmation ? { asked: result.needsConfirmation.question } : {}),
          })),
        ),
        feedback: row.feedback,
        status: row.status,
        error: row.error,
        latencyMs: row.latencyMs,
        model: row.model,
        createdAt: readClock(),
      });
    } catch (error) {
      logger?.warn('could not record the interaction', error);
    }
  }

  function executorFor(at: number) {
    return createExecutor({
      repos,
      zone,
      now: at,
      ...(options.effects ? { effects: options.effects } : {}),
      ...(logger ? { logger } : {}),
      confirmMode: options.confirmMode ?? 'never',
    });
  }

  /** The user answered a confirmation. Re-runs the exact actions we parked. */
  async function applyPending(
    state: Extract<PendingState, { kind: 'confirm' }>,
    input: TurnInput,
    startedAt: number,
  ): Promise<TurnOutcome> {
    const executor = executorFor(startedAt);
    const pairs: { action: LlmAction; result: ActionResult }[] = [];
    for (const action of state.actions) {
      pairs.push({ action, result: await executor.execute(action, { confirmed: true }) });
    }

    const results = pairs.map((pair) => pair.result);
    const clarification = clarificationFor(state.transcript, pairs, { alreadyConfirmed: true });
    const feedback = composeFeedback(undefined, results);

    await audit({
      transcript: input.transcript,
      confidence: input.confidence ?? null,
      raw: null,
      results: pairs,
      feedback,
      status: clarification ? 'clarify' : statusOf(results),
      error: null,
      latencyMs: elapsed(startedAt),
      // No provider was involved, and pretending otherwise would make the audit
      // trail read as if the model confirmed its own action.
      model: null,
    });

    return {
      transcript: input.transcript,
      feedback,
      items: results.map(toItem),
      speak: shouldSpeak(results),
      ...(clarification ? { clarification } : {}),
    };
  }

  async function abandonPending(
    state: PendingState,
    input: TurnInput,
    startedAt: number,
  ): Promise<TurnOutcome> {
    const feedback = 'Alright, I left it alone.';
    await audit({
      transcript: input.transcript,
      confidence: input.confidence ?? null,
      raw: null,
      results: [],
      feedback,
      status: 'ok',
      error: null,
      latencyMs: elapsed(startedAt),
      model: null,
    });
    logger?.info('pending action abandoned', { kind: state.kind });
    return { transcript: input.transcript, feedback, items: [] };
  }

  /**
   * Nothing inside `runTurn` is meant to throw — the client returns Results,
   * the executor catches per action, the context degrades a section at a time
   * — but "every turn is audited" is only true if the unexpected one is too,
   * and without this the dock would speak whatever an internal Error said.
   */
  async function interpretAndExecute(input: TurnInput): Promise<TurnOutcome> {
    const startedAt = readClock();
    const transcript = input.transcript.trim();
    try {
      return await runTurn({ ...input, transcript }, startedAt);
    } catch (error) {
      logger?.error('voice turn threw', error);
      const feedback = 'Something went wrong on my side. Please try that again.';
      await audit({
        transcript,
        confidence: input.confidence ?? null,
        raw: null,
        results: [],
        feedback,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        latencyMs: elapsed(startedAt),
        model: null,
      });
      return { transcript, feedback, items: [] };
    }
  }

  /** `input.transcript` arrives already trimmed. */
  async function runTurn(input: TurnInput, startedAt: number): Promise<TurnOutcome> {
    const { transcript } = input;
    const pending = parsePending(input.pending);

    if (pending) {
      const verdict = classifyConfirmation(transcript);
      if (verdict === 'no') return abandonPending(pending, input, startedAt);
      if (verdict === 'yes' && pending.kind === 'confirm') {
        return applyPending(pending, input, startedAt);
      }
    }

    const weekStart = await readWeekStart();
    const context = await buildLlmContext({
      repos,
      now: startedAt,
      zone,
      weekStart,
      ...(logger ? { logger } : {}),
    });

    const history = historyFor(pending, input.pending);
    const interpretation = await client.interpret({
      transcript,
      context,
      ...(history.length > 0 ? { history } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (!interpretation.ok) {
      // Every path out of the client already carries a sentence written to be
      // spoken, so the failure is repeated verbatim rather than re-worded.
      const feedback = interpretation.error.userMessage;
      await audit({
        transcript,
        confidence: input.confidence ?? null,
        raw: null,
        results: [],
        feedback,
        status: 'error',
        error: `${interpretation.error.code}: ${interpretation.error.message}`,
        latencyMs: elapsed(startedAt),
        model: null,
      });
      return { transcript, feedback, items: [] };
    }

    const { response, raw, model, usage, degraded } = interpretation.value;
    const executor = executorFor(startedAt);
    const results =
      response.actions.length > 0 ? await executor.executeAll(response.actions) : [];
    // `executeAll` returns one result per action, in order, so the pairing is
    // positional; the guard is only here because the types cannot say so.
    const pairs = results.flatMap((result, index) => {
      const action = response.actions[index];
      return action ? [{ action, result }] : [];
    });

    const asked = clarificationFor(transcript, pairs);
    const modelQuestion =
      response.requires_user_input && response.clarification ? response.clarification : null;
    const clarification =
      asked ??
      (modelQuestion
        ? {
            question: modelQuestion.question,
            pending: encodePending({
              v: 1,
              kind: 'clarify',
              question: modelQuestion.question,
              transcript,
              ...(modelQuestion.pending ? { hint: modelQuestion.pending } : {}),
            }),
          }
        : undefined);

    const feedback = composeFeedback(response.conversational_feedback, results);

    await audit({
      transcript,
      confidence: input.confidence ?? null,
      raw,
      results: pairs,
      feedback,
      status: clarification ? 'clarify' : statusOf(results),
      // A degraded turn succeeds, so nothing else in the row would ever show
      // that the model failed three times and the offline engine answered.
      // Without this, "why did my dentist appointment become a note?" has no
      // answer anywhere in the app.
      error: degraded
        ? `degraded to offline: ${(interpretation.value.issues ?? []).slice(0, 3).join('; ')}`
        : null,
      latencyMs: elapsed(startedAt),
      model,
    });

    return {
      transcript,
      feedback,
      items: results.map(toItem),
      speak: shouldSpeak(results),
      usage: { model, inputTokens: usage?.input, outputTokens: usage?.output },
      ...(clarification ? { clarification } : {}),
    };
  }

  /** A bad settings row must not stop a turn; Monday is the app-wide default. */
  async function readWeekStart(): Promise<'monday' | 'sunday'> {
    try {
      return (await repos.settings.get('weekStartsOn')) === 0 ? 'sunday' : 'monday';
    } catch (error) {
      logger?.warn('could not read the week start', error);
      return 'monday';
    }
  }

  return { interpretAndExecute, zone };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;

/* ---------------------------------------------------------------- helpers -- */

function elapsed(startedAt: number): number {
  return Math.max(0, readClock() - startedAt);
}

/** A turn that wrote nothing the user asked for is an error, even without a throw. */
function statusOf(results: ActionResult[]): 'ok' | 'error' {
  return results.some((result) => !result.ok) ? 'error' : 'ok';
}

function toItem(result: ActionResult): TurnItem {
  return {
    toolName: result.toolName,
    ok: result.ok,
    summary: result.summary,
    ...(result.detail ? { detail: result.detail } : {}),
    ...(result.href ? { href: result.href } : {}),
    ...(result.entityId ? { entityId: result.entityId } : {}),
  };
}

/**
 * Folds every action the executor refused to guess at into one question.
 *
 * More than one is rare — it takes an utterance whose second and third intents
 * are both ambiguous — but the dock has room for exactly one question, and
 * dropping the others would silently lose the work.
 *
 * Which envelope it lands in matters more than the wording. Only a yes/no can
 * be parked as a `confirm`: replaying those actions under `confirmed` is what
 * the answer means. "Which one did you mean?" is not a yes/no — `confirmed`
 * deliberately never turns an ambiguous match into a guess — so replaying it
 * would ask the identical question for ever while the user says yes into the
 * void. Those go back to the model as a `clarify`, where "the drone one" can
 * actually narrow the query. One ambiguous action makes the whole batch a
 * clarify: the model re-plans the utterance from its own question, which is
 * slower than a local yes but never loops and never writes the wrong row.
 */
function clarificationFor(
  transcript: string,
  pairs: { action: LlmAction; result: ActionResult }[],
  options: { alreadyConfirmed?: boolean } = {},
): { question: string; pending: string } | undefined {
  const blocked = pairs.filter((pair) => pair.result.needsConfirmation);
  const first = blocked[0];
  if (!first?.result.needsConfirmation) return undefined;

  // Anything still blocked *after* a yes cannot be unblocked by a second one,
  // whatever it says about itself; asking again is the loop by another name.
  const answerable =
    options.alreadyConfirmed !== true &&
    blocked.every((pair) => pair.result.needsConfirmation?.ambiguous !== true);

  const rest = blocked.length - 1;
  const question =
    rest === 0
      ? first.result.needsConfirmation.question
      : `${first.result.needsConfirmation.question} ${countLabel(rest, 'other thing')} ${
          rest === 1 ? 'needs' : 'need'
        } an answer too${answerable ? ' — yes covers them all' : ''}.`;

  return {
    question,
    pending: encodePending(
      answerable
        ? {
            v: 1,
            kind: 'confirm',
            question,
            transcript,
            actions: blocked.map((pair) => pair.action),
          }
        : { v: 1, kind: 'clarify', question, transcript },
    ),
  };
}

/**
 * What the model is told about the turn it is finishing.
 *
 * Only reached when the answer was not a plain yes or no, i.e. the user said
 * something the model has to read — "the one on Friday", "make it 3pm". Without
 * the question it asked, the reply is a fragment with no subject.
 */
function historyFor(pending: PendingState | null, raw: string | undefined): LlmMessage[] {
  if (pending) {
    return [
      { role: 'user', content: pending.transcript },
      { role: 'model', content: pending.question },
    ];
  }
  // Not our envelope: the model's own free-text note to itself, which is still
  // the best description of what it was waiting for.
  return raw ? [{ role: 'model', content: raw }] : [];
}

/**
 * One sentence, spoken. The model's own line wins when it wrote one — it read
 * the utterance and we only read the results — and everything else is a
 * fallback so the dock is never silent.
 */
export function composeFeedback(
  modelFeedback: string | undefined,
  results: ActionResult[],
): string {
  const spoken = modelFeedback?.trim();
  if (spoken) return limitWords(spoken, FEEDBACK_WORD_CAP);
  return limitWords(summarise(results), FEEDBACK_WORD_CAP);
}

function summarise(results: ActionResult[]): string {
  if (results.length === 0) return 'Okay.';

  const applied = results.filter((r) => r.ok);
  const asked = results.filter((r) => !r.ok && r.needsConfirmation);
  const failed = results.filter((r) => !r.ok && !r.needsConfirmation);

  if (applied.length === 1 && failed.length === 0 && asked.length === 0) {
    return applied[0]!.summary;
  }
  if (applied.length === 0 && failed.length === 1 && asked.length === 0) {
    return failed[0]!.summary;
  }
  if (applied.length === 0 && failed.length === 0) return 'I need one more thing first.';

  const parts: string[] = [];
  if (applied.length > 0) parts.push(`Done: ${countLabel(applied.length, 'thing')}`);
  if (failed.length > 0) parts.push(`${countLabel(failed.length, 'thing')} did not work`);
  return `${parts.join(', ')}.`;
}

export function limitWords(text: string, max: number): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  if (words.length <= max) return text.trim();
  return `${words.slice(0, max).join(' ').replace(/[,;:.]$/, '')}…`;
}
