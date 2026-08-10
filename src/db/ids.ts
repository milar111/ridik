/**
 * ULID-style identifiers: 48-bit big-endian timestamp + 80 bits of randomness,
 * Crockford base32. Lexicographically sortable by creation time, which lets us
 * order rows without an extra index and keeps ids stable across offline sync.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)
const TIME_LEN = 10;
const RANDOM_LEN = 16;

type RandomSource = (bytes: Uint8Array) => Uint8Array;

const insecureRandom: RandomSource = (bytes) => {
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
};

let randomSource: RandomSource = (() => {
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    return (bytes: Uint8Array) => {
      webCrypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>);
      return bytes;
    };
  }
  return insecureRandom;
})();

/**
 * React Native has no global WebCrypto; the app bootstrap injects
 * `expo-crypto`'s implementation here. Tests and Node use the global one.
 */
export function setRandomSource(source: RandomSource): void {
  randomSource = source;
}

function encodeTime(now: number): string {
  let time = now;
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = time % 32;
    out = ENCODING[mod] + out;
    time = (time - mod) / 32;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomSource(new Uint8Array(RANDOM_LEN));
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) out += ENCODING[bytes[i]! % 32];
  return out;
}

let lastTime = -1;
let lastRandom = '';

/** Monotonic within a millisecond so bulk inserts keep insertion order. */
export function newId(): string {
  const now = Date.now();
  if (now === lastTime) {
    lastRandom = incrementBase32(lastRandom);
  } else {
    lastTime = now;
    lastRandom = encodeRandom();
  }
  return encodeTime(now) + lastRandom;
}

function incrementBase32(str: string): string {
  const chars = str.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    const idx = ENCODING.indexOf(chars[i]!);
    if (idx < ENCODING.length - 1) {
      chars[i] = ENCODING[idx + 1]!;
      return chars.join('');
    }
    chars[i] = ENCODING[0]!;
  }
  // Overflowed a full 80-bit space inside one millisecond; start fresh.
  return encodeRandom();
}

/** Extracts the creation timestamp encoded in an id, or null if malformed. */
export function idTimestamp(id: string): number | null {
  if (id.length < TIME_LEN) return null;
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const idx = ENCODING.indexOf(id[i]!);
    if (idx === -1) return null;
    time = time * 32 + idx;
  }
  return time;
}
