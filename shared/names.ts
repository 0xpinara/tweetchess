/**
 * Public display names. Guests pick (or are given) a name that other players
 * and spectators see. Names are plain text: validated here, escaped by React
 * when rendered, and never used in HTML built on the server.
 */

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 20;
export const DEFAULT_NAME = 'Guest';

/** Letters and digits from any script, plus space . _ ' - (not leading). */
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;

/**
 * Normalise and validate a display name. Returns null when it isn't
 * acceptable (wrong length, control/invisible characters, symbols, emoji…).
 */
export function sanitizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) return null;
  if (!NAME_PATTERN.test(name)) return null;
  return name;
}

const ADJECTIVES = [
  'Swift', 'Bold', 'Quiet', 'Clever', 'Lucky', 'Brave', 'Calm', 'Sharp', 'Witty', 'Royal',
  'Sly', 'Keen', 'Noble', 'Rapid', 'Steady', 'Cosmic', 'Sunny', 'Misty', 'Golden', 'Silver',
];
const NOUNS = [
  'Rook', 'Knight', 'Bishop', 'Pawn', 'Queen', 'King', 'Ace', 'Joker', 'Falcon', 'Fox',
  'Otter', 'Tiger', 'Panda', 'Raven', 'Wolf', 'Comet', 'River', 'Maple', 'Harbor', 'Pixel',
];

/** A friendly random name such as "Swift Falcon 27". */
export function randomDisplayName(random: () => number = Math.random): string {
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  return `${pick(ADJECTIVES)} ${pick(NOUNS)} ${10 + Math.floor(random() * 90)}`;
}
