/**
 * The guest's public display name, kept in localStorage. A random friendly
 * name is generated on the first visit; the player can change it any time.
 */
import { useSyncExternalStore } from 'react';
import { randomDisplayName, sanitizeDisplayName } from '../../shared/names.ts';

const STORAGE_KEY = 'tweetchess.displayName.v1';
const listeners = new Set<() => void>();
let memoryName: string | null = null;

export function getDisplayName(): string {
  try {
    const stored = sanitizeDisplayName(localStorage.getItem(STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // Storage blocked: fall back to memory.
  }
  if (!memoryName) {
    memoryName = randomDisplayName();
    try {
      localStorage.setItem(STORAGE_KEY, memoryName);
    } catch {
      // Keep it in memory only.
    }
  }
  return memoryName;
}

/** Save a new name. Returns false (and changes nothing) if it isn't valid. */
export function setDisplayName(raw: string): boolean {
  const name = sanitizeDisplayName(raw);
  if (!name) return false;
  memoryName = name;
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Memory only.
  }
  for (const listener of listeners) listener();
  return true;
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

export function useDisplayName(): string {
  return useSyncExternalStore(subscribe, getDisplayName);
}
