/**
 * Anonymous guest identity.
 *
 * A 256-bit random token is generated with the browser's CSPRNG and kept in
 * localStorage. It is sent to the server only inside the WebSocket (never in
 * a URL), and the server stores just a SHA-256 hash of it. Whoever holds the
 * token owns the seat, so refreshing the page gets your seat back.
 */
const STORAGE_KEY = 'tweetchess.guestToken.v1';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

let memoryToken: string | null = null;

export function getGuestToken(): string {
  for (const storage of availableStorages()) {
    try {
      const existing = storage.getItem(STORAGE_KEY);
      if (existing && TOKEN_PATTERN.test(existing)) return existing;
    } catch {
      // Storage may be blocked (private mode, sandboxed iframe).
    }
  }
  if (memoryToken) return memoryToken;

  const token = createToken();
  for (const storage of availableStorages()) {
    try {
      storage.setItem(STORAGE_KEY, token);
      return token;
    } catch {
      // Try the next storage.
    }
  }
  // Last resort: the seat survives reconnects but not a page refresh.
  memoryToken = token;
  return token;
}

/** True when the identity will survive a page refresh. */
export function isIdentityPersistent(): boolean {
  getGuestToken();
  return memoryToken === null;
}

export function createToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function availableStorages(): Storage[] {
  const storages: Storage[] = [];
  try {
    if (typeof localStorage !== 'undefined') storages.push(localStorage);
  } catch {
    // Accessing localStorage itself can throw.
  }
  try {
    if (typeof sessionStorage !== 'undefined') storages.push(sessionStorage);
  } catch {
    // Same for sessionStorage.
  }
  return storages;
}
