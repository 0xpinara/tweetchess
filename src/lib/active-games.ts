/**
 * Games this browser is currently seated in, so the homepage can offer
 * "Return to your game". Kept in localStorage; the server stays the source of
 * truth (opening the game re-checks the seat).
 */
import { useSyncExternalStore } from 'react';

export interface ActiveGame {
  game: 'chess' | 'poker';
  id: string;
  /** Short description, e.g. "vs Bold Rook 27" or "Poker table". */
  label: string;
  at: number;
}

const STORAGE_KEY = 'tweetchess.activeGames.v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5;
const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cachedList: ActiveGame[] = [];

function read(): ActiveGame[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === cachedRaw) return cachedList;
  cachedRaw = raw;
  try {
    const parsed = JSON.parse(raw ?? '[]');
    cachedList = Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is ActiveGame =>
            entry &&
            (entry.game === 'chess' || entry.game === 'poker') &&
            typeof entry.id === 'string' &&
            typeof entry.label === 'string' &&
            typeof entry.at === 'number' &&
            Date.now() - entry.at < MAX_AGE_MS,
        )
      : [];
  } catch {
    cachedList = [];
  }
  return cachedList;
}

function write(list: ActiveGame[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch {
    // Not remembered.
  }
  for (const listener of listeners) listener();
}

export function rememberActiveGame(entry: Omit<ActiveGame, 'at'>): void {
  const others = read().filter((game) => !(game.game === entry.game && game.id === entry.id));
  write([{ ...entry, at: Date.now() }, ...others]);
}

export function forgetActiveGame(game: ActiveGame['game'], id: string): void {
  const list = read();
  if (list.some((entry) => entry.game === game && entry.id === id)) {
    write(list.filter((entry) => !(entry.game === game && entry.id === id)));
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useActiveGames(): ActiveGame[] {
  return useSyncExternalStore(subscribe, read);
}
