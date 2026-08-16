/**
 * A scripted provider for tests, and the app's offline mode.
 *
 * With a script it replays canned replies and can fail the first N calls so the
 * retry ladder can be exercised without sleeping. With no script it falls back
 * to `fallbackInterpret`, a deliberately tiny rule engine that keeps the app
 * usable with no API key.
 */
import { now } from '@/core/clock';
import { AppError } from '@/core/result';
import { currentZone, epochToLocal } from '@/core/time';
import {
  llmResponseSchema,
  normaliseCurrency,
  type actionSchema,
  type LlmResponse,
} from '@/llm/contract';
import type { z } from 'zod';
import { LlmProviderError, type LlmCompletion, type LlmProvider, type LlmRequest } from './types';

export type MockResponder = (req: LlmRequest, callIndex: number) => string;

export type MockProviderOptions = {
  /** Replies served in order, or a function of the request. */
  responses?: readonly string[] | MockResponder;
  /** Reject this many leading calls before serving anything. */
  failTimes?: number;
  failWith?: LlmProviderError | ((callIndex: number) => LlmProviderError);
  model?: string;
  name?: string;
  configured?: boolean;
  latencyMs?: number;
};

export type MockLlmProvider = LlmProvider & {
  readonly requests: readonly LlmRequest[];
  readonly calls: number;
  reset(): void;
};

const DEFAULT_FAILURE = () =>
  new LlmProviderError('rate_limited', 'Mock provider: rate limited.', { status: 429 });

export function createMockProvider(options: MockProviderOptions = {}): MockLlmProvider {
  const model = options.model ?? 'mock-1';
  const requests: LlmRequest[] = [];
  let calls = 0;
  let served = 0;
  let failuresLeft = options.failTimes ?? 0;

  const failure = (index: number): LlmProviderError => {
    if (typeof options.failWith === 'function') return options.failWith(index);
    return options.failWith ?? DEFAULT_FAILURE();
  };

  const nextText = (req: LlmRequest, index: number): string => {
    const { responses } = options;
    if (typeof responses === 'function') return responses(req, index);
    if (responses) {
      const text = responses[index];
      if (text === undefined) {
        throw new AppError(
          'invalid_input',
          `Mock provider ran out of scripted replies after ${responses.length}.`,
        );
      }
      return text;
    }
    return JSON.stringify(fallbackInterpret(lastUserMessage(req)));
  };

  return {
    name: options.name ?? 'mock',
    model,

    isConfigured: () => options.configured ?? true,

    async complete(req: LlmRequest): Promise<LlmCompletion> {
      requests.push(req);
      const index = calls++;
      if (failuresLeft > 0) {
        failuresLeft--;
        throw failure(index);
      }
      const text = nextText(req, served++);
      return { text, model, latencyMs: options.latencyMs ?? 0 };
    },

    get requests() {
      return requests;
    },
    get calls() {
      return calls;
    },
    reset() {
      requests.length = 0;
      calls = 0;
      served = 0;
      failuresLeft = options.failTimes ?? 0;
    },
  };
}

function lastUserMessage(req: LlmRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const message = req.messages[i]!;
    if (message.role === 'user') return message.content;
  }
  return '';
}

/* ------------------------------------------------- degraded offline engine -- */

/**
 * NOT a language model. Four hand-written patterns so a user with no API key
 * still captures something; everything unrecognised becomes a note, which is
 * lossless even when the classification is wrong.
 */
const REMIND_RE =
  /\bremind me\s+(?:to\s+|about\s+)?(.+?)\s+(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*$/i;
const SPENT_RE = /\b(?:spent|paid)\s+([\d]+(?:[.,]\d{1,2})?)\s*(\S+)?\s+(?:on|for)\s+(.+)/i;

/**
 * Where a spend category stops and a second sentence begins.
 *
 * `SPENT_RE` ends in `(.+)`, which runs to the end of the utterance — so
 * "spent 12 leva on lunch and I ran 5k this morning" logged an expense
 * categorised "lunch and I ran 5k this morning" and dropped the run. Silently:
 * one plausible-looking receipt, half the sentence gone.
 *
 * Cutting at every "and" is worse, because "lunch and drinks" is one category
 * and the commonest shape there is. So the split only happens on a conjunction
 * followed by something that is unmistakably a NEW instruction — a subject and
 * a verb ("and I ran"), or an imperative this matcher itself recognises. A bare
 * noun phrase after "and" stays part of the category, which is the safe
 * default: over-capturing a category is a wrong label on the right amount,
 * while over-splitting invents a boundary the user did not say.
 *
 * The rest of the utterance is not recovered — this is the degraded engine and
 * it has one pattern per turn. But `description` keeps the whole sentence, so
 * what was said survives even when only half of it was understood.
 */
const SECOND_INTENT_RE =
  /\s+(?:and|then|also)\s+(?=(?:i|we|you)\s+\w|(?:add|remind|log|start|note|call|book|schedule)\b)/i;
const CHECKLIST_RE = /\badd\s+(.+?)\s+to\s+(?:my|the)?\s*(.+?)\s+list\b/i;

const CURRENCY_TOKENS = new Set([
  'eur', 'euro', 'euros', '€',
  'usd', 'dollar', 'dollars', 'bucks', '$',
  'gbp', 'pound', 'pounds', 'quid', '£',
  'bgn', 'lev', 'leva', 'лв', 'лв.',
]);

export function fallbackInterpret(transcript: string): LlmResponse {
  const text = transcript.trim();
  if (!text) {
    return llmResponseSchema.parse({
      conversational_feedback: "I didn't catch that.",
      requires_user_input: true,
      clarification: { question: 'Sorry, what was that?' },
      actions: [],
    });
  }

  const zone = currentZone();
  const at = now();

  // Every branch below re-checks its own extracted text: `strip` can annihilate
  // an all-punctuation capture ("remind me to . at 5"), and an empty required
  // field would throw out of `build` instead of degrading to a note.
  const remind = REMIND_RE.exec(text);
  const remindTitle = remind?.[1] ? capitalise(strip(remind[1])) : '';
  if (remind?.[2] && remindTitle) {
    const hour = to24Hour(Number(remind[2]), remind[4]);
    const minute = Number(remind[3] ?? 0);
    return build('Reminder set (offline).', {
      tool_name: 'calendar_add',
      parameters: {
        title: remindTitle,
        start: nextOccurrence(hour, minute, zone, at),
        kind: 'reminder',
        schedule_reason: 'Offline fallback: next occurrence of the time you said.',
      },
    });
  }

  const spent = SPENT_RE.exec(text);
  if (spent?.[1] && spent[3]) {
    const amount = Number(spent[1].replace(',', '.'));
    const token = spent[2]?.toLowerCase();
    const currency = token && CURRENCY_TOKENS.has(token) ? normaliseCurrency(token) : 'EUR';
    const category = clamp(strip(spent[3].split(SECOND_INTENT_RE)[0]!), 80);
    if (Number.isFinite(amount) && amount > 0 && category) {
      return build('Expense logged (offline).', {
        tool_name: 'ledger_add',
        parameters: {
          amount,
          currency,
          category,
          description: clamp(text, 500) || text.slice(0, 500),
          direction: 'expense',
        },
      });
    }
  }

  const checklist = CHECKLIST_RE.exec(text);
  if (checklist?.[1] && checklist[2]) {
    const items = checklist[1]
      .split(/\s*,\s*|\s+and\s+/i)
      .map((item) => clamp(strip(item), 200))
      .filter((item) => item.length > 0);
    const listName = clamp(strip(checklist[2]), 80);
    if (items.length > 0 && listName) {
      return build('Added to your list (offline).', {
        tool_name: 'checklist_add',
        parameters: { list_name: listName, items },
      });
    }
  }

  // Last resort: the raw text, unstripped. A note we cannot title cleanly still
  // beats losing what the user said.
  const body = clamp(text, 1000) || text.slice(0, 1000);
  return build('Saved as a note (offline).', {
    tool_name: 'note_create',
    parameters: {
      title_summary: titleOf(text) || body.slice(0, 160),
      category_tag: 'inbox',
      bullets: [body],
    },
  });
}

type ActionDraft = z.input<typeof actionSchema>;

function build(feedback: string, action: ActionDraft): LlmResponse {
  return llmResponseSchema.parse({
    conversational_feedback: feedback,
    requires_user_input: false,
    actions: [action],
  });
}

function nextOccurrence(hour: number, minute: number, zone: string, from: number): string {
  let dt = epochToLocal(from, zone).set({ hour, minute, second: 0, millisecond: 0 });
  if (dt.toMillis() <= from) dt = dt.plus({ days: 1 });
  return dt.toFormat("yyyy-MM-dd'T'HH:mm");
}

function to24Hour(hour: number, meridiem: string | undefined): number {
  const m = meridiem?.toLowerCase().replace(/\./g, '');
  if (m === 'pm') return hour === 12 ? 12 : Math.min(hour + 12, 23);
  if (m === 'am') return hour === 12 ? 0 : hour;
  // Bare "at 3" is the afternoon far more often than 3am.
  return hour >= 1 && hour <= 7 ? hour + 12 : Math.min(hour, 23);
}

function strip(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/^[\s,.;:-]+|[\s,.;:!?-]+$/g, '').trim();
}

function clamp(text: string, max: number): string {
  const flat = strip(text);
  return flat.length <= max ? flat : flat.slice(0, max).trim();
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

function titleOf(text: string): string {
  const firstSentence = strip(text.split(/[.!?\n]/)[0] ?? text);
  const source = firstSentence.length > 0 ? firstSentence : strip(text);
  if (source.length <= 60) return capitalise(source);
  const cut = source.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  return capitalise(lastSpace > 20 ? cut.slice(0, lastSpace) : cut);
}
