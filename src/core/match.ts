/**
 * Fuzzy entity resolution.
 *
 * The model refers to things the way the user said them ("my math homework",
 * "the meeting with Ivo"), never by id. Every "update/delete/toggle the X" path
 * funnels through here: score candidates, then require a clear winner before
 * mutating anything — a wrong match silently destroys user data, so ambiguity
 * must surface as a question rather than a guess.
 */

export type Candidate<T> = {
  item: T;
  /** Primary text, weighted highest. */
  text: string;
  /** Secondary text (tags, notes, location) matched at a discount. */
  aux?: string[];
  /** Recency/priority nudge in [0,1]; breaks near-ties. */
  boost?: number;
};

export type Scored<T> = { item: T; score: number; text: string };

export type MatchOptions = {
  /** Minimum score to be considered a candidate at all. */
  threshold?: number;
  /** How far ahead the winner must be to count as unambiguous. */
  decisiveMargin?: number;
};

const DEFAULTS: Required<MatchOptions> = { threshold: 0.34, decisiveMargin: 0.12 };

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'my', 'me', 'i', 'to', 'for', 'of', 'on', 'at', 'in', 'with',
  'and', 'or', 'is', 'was', 'be', 'do', 'did', 'that', 'this', 'it', 'please',
]);

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    // strip combining marks so "café" matches "cafe"
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text: string): string[] {
  return normalise(text)
    .split(' ')
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

/** Levenshtein distance with an early exit once `max` is exceeded. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** 1 = identical, 0 = nothing in common. */
export function similarity(a: string, b: string): number {
  const na = normalise(a);
  const nb = normalise(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const longest = Math.max(na.length, nb.length);
  return 1 - editDistance(na, nb) / longest;
}

/**
 * Token-aware score in [0,1].
 *
 * Blends four signals so short queries against long titles still work:
 * exact/substring containment, token overlap, per-token fuzzy matching (for
 * transcription slips like "phisics"), and ordered-prefix agreement.
 */
export function scoreText(query: string, target: string): number {
  const nq = normalise(query);
  const nt = normalise(target);
  if (!nq || !nt) return 0;
  if (nq === nt) return 1;

  const qTokens = tokenize(query);
  const tTokens = tokenize(target);
  if (qTokens.length === 0 || tTokens.length === 0) return similarity(query, target) * 0.6;

  let containment = 0;
  if (nt.includes(nq)) containment = 0.85 + 0.15 * (nq.length / nt.length);
  else if (nq.includes(nt)) containment = 0.75 + 0.15 * (nt.length / nq.length);

  let matched = 0;
  let fuzzyTotal = 0;
  for (const qt of qTokens) {
    let best = 0;
    for (const tt of tTokens) {
      if (qt === tt) {
        best = 1;
        break;
      }
      if (tt.startsWith(qt) || qt.startsWith(tt)) {
        best = Math.max(best, 0.85);
        continue;
      }
      const maxLen = Math.max(qt.length, tt.length);
      if (maxLen >= 4) {
        const d = editDistance(qt, tt, 2);
        if (d <= 2) best = Math.max(best, 1 - d / maxLen);
      }
    }
    if (best >= 0.8) matched++;
    fuzzyTotal += best;
  }

  const coverage = matched / qTokens.length;
  const fuzzyCoverage = fuzzyTotal / qTokens.length;
  // Reward matching a large share of the target too, so "math" does not beat
  // "math homework" when the user said "math homework".
  const density = matched / Math.max(tTokens.length, qTokens.length);

  return Math.min(
    1,
    Math.max(containment, 0.5 * coverage + 0.3 * fuzzyCoverage + 0.2 * density),
  );
}

export function scoreCandidate<T>(query: string, candidate: Candidate<T>): number {
  let score = scoreText(query, candidate.text);
  for (const aux of candidate.aux ?? []) {
    score = Math.max(score, scoreText(query, aux) * 0.72);
  }
  // Boost is a tiebreaker, never enough to promote an irrelevant row.
  return Math.min(1, score + (candidate.boost ?? 0) * 0.06);
}

export function rank<T>(query: string, candidates: Candidate<T>[], options?: MatchOptions): Scored<T>[] {
  const { threshold } = { ...DEFAULTS, ...options };
  return candidates
    .map((c) => ({ item: c.item, score: scoreCandidate(query, c), text: c.text }))
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

export type MatchOutcome<T> =
  | { kind: 'none' }
  | { kind: 'unique'; match: Scored<T> }
  | { kind: 'ambiguous'; matches: Scored<T>[] };

/**
 * Resolves a query to at most one item. When the top two candidates are within
 * `decisiveMargin`, the caller is expected to ask the user rather than pick.
 */
export function resolveOne<T>(
  query: string,
  candidates: Candidate<T>[],
  options?: MatchOptions,
): MatchOutcome<T> {
  const opts = { ...DEFAULTS, ...options };
  const ranked = rank(query, candidates, opts);
  if (ranked.length === 0) return { kind: 'none' };
  const [first, second] = ranked;
  if (!second || first!.score - second.score >= opts.decisiveMargin) {
    return { kind: 'unique', match: first! };
  }
  return { kind: 'ambiguous', matches: ranked.slice(0, 5) };
}
