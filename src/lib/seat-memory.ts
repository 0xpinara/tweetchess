/**
 * Remembers rooms where you clicked "Leave seat", so reopening the link later
 * doesn't silently put you back in a free seat. Kept in localStorage.
 */
const STORAGE_KEY = 'tweetchess.leftRooms.v1';
const MAX_ROOMS = 30;

function read(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function write(rooms: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms.slice(-MAX_ROOMS)));
  } catch {
    // Storage unavailable: the preference just isn't remembered.
  }
}

export function hasLeftRoom(roomId: string): boolean {
  return read().includes(roomId);
}

export function rememberLeftRoom(roomId: string): void {
  write([...read().filter((id) => id !== roomId), roomId]);
}

export function forgetLeftRoom(roomId: string): void {
  write(read().filter((id) => id !== roomId));
}
