/**
 * Presentation helpers shared by the UI and the spoken briefing.
 *
 * Speech and screen need different shapes of the same fact ("€12.50" vs
 * "twelve euros fifty"), so both live here and stay consistent.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  JPY: '¥',
  BGN: 'лв',
  INR: '₹',
  RUB: '₽',
};

const CURRENCY_WORDS: Record<string, [string, string]> = {
  EUR: ['euro', 'euros'],
  USD: ['dollar', 'dollars'],
  GBP: ['pound', 'pounds'],
  JPY: ['yen', 'yen'],
  BGN: ['lev', 'leva'],
  INR: ['rupee', 'rupees'],
  RUB: ['rouble', 'roubles'],
};

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);

export function formatMoney(amount: number, currency: string, options: { compact?: boolean } = {}): string {
  const code = currency.toUpperCase();
  const digits = ZERO_DECIMAL.has(code) ? 0 : 2;
  const symbol = CURRENCY_SYMBOLS[code];
  const rounded = amount.toFixed(digits);
  const withSeparators = addThousandSeparators(rounded);
  if (options.compact && Math.abs(amount) >= 1000) {
    const compact = `${(amount / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return symbol ? `${symbol}${compact}` : `${compact} ${code}`;
  }
  return symbol ? `${symbol}${withSeparators}` : `${withSeparators} ${code}`;
}

/** "twelve euros fifty" reads badly; "12 euros 50" is what a briefing should say. */
export function speakMoney(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const words = CURRENCY_WORDS[code];
  const whole = Math.floor(Math.abs(amount));
  const cents = Math.round((Math.abs(amount) - whole) * 100);
  const unit = words ? (whole === 1 && cents === 0 ? words[0] : words[1]) : code;
  const base = `${whole} ${unit}`;
  return cents > 0 ? `${base} ${cents}` : base;
}

/**
 * "1,000" on every device.
 *
 * `Number.toLocaleString()` with no locale argument formats against the
 * *device's* — so the same allowance rendered "1,000" on one phone and
 * "1 000" (narrow no-break space) on another, in an app whose own prices are
 * written one way. Every number this app shows goes through here or through
 * `formatMoney`.
 */
export function formatCount(value: number): string {
  return addThousandSeparators(String(Math.round(value)));
}

function addThousandSeparators(value: string): string {
  const [intPart = '', decPart] = value.split('.');
  const sign = intPart.startsWith('-') ? '-' : '';
  const digits = sign ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart ? `${sign}${grouped}.${decPart}` : `${sign}${grouped}`;
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function countLabel(count: number, singular: string, plural?: string): string {
  return `${count} ${pluralise(count, singular, plural)}`;
}

/** "a, b and c" — Oxford-comma-free, which is what TTS should read. */
export function joinNatural(items: string[], conjunction = 'and'): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`;
}

export function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function titleCase(text: string): string {
  return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/** Percentage rounded for display; guards the 0/0 case that reads as NaN. */
export function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

/**
 * Milliseconds, read as a person would say them.
 *
 * Lives here rather than on the screen that first needed it because two now do:
 * the history header shows what one turn took, and the developer screen shows
 * what the last hundred took. `null` for anything that is not a real duration —
 * an absent latency is not "0 ms", and a read-out that says so is a lie about a
 * measurement nobody made.
 */
export function formatLatency(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
