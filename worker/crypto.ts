/** Small crypto helpers shared by the Worker and its Durable Objects. */
import { ROOM_ID_LENGTH, WORLD_ROOM_ID } from '../shared/protocol.ts';

/**
 * Only a hash of a guest token is ever stored or compared. Every Durable
 * Object uses this same function, so a guest's identity matches everywhere.
 */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(`tweetchess:guest:${token}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Unbiased random base62 ID from the Web Crypto CSPRNG (used for chess rooms and poker tables). */
export function randomRoomId(): string {
  let id = '';
  while (id.length < ROOM_ID_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // 248 = 4 × 62: discard bytes ≥ 248 to avoid modulo bias.
      if (byte < 248 && id.length < ROOM_ID_LENGTH) id += ALPHABET[byte % 62];
    }
  }
  return id === WORLD_ROOM_ID ? randomRoomId() : id;
}

/** Unbiased random integer in [0, maxExclusive) from the CSPRNG (rejection sampling). */
export function secureRandomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 2 ** 32) {
    throw new RangeError('maxExclusive must be an integer in 1..2^32');
  }
  const limit = Math.floor(2 ** 32 / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0] < limit) return buffer[0] % maxExclusive;
  }
}
