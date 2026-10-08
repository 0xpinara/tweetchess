import { WORLD_ROOM_ID } from '../../shared/protocol.ts';

export function roomPath(roomId: string): string {
  return roomId === WORLD_ROOM_ID ? '/world' : `/game/${roomId}`;
}

export function roomUrl(roomId: string): string {
  return `${window.location.origin}${roomPath(roomId)}`;
}

/**
 * X's free Web Intent: opens the post composer with text and link pre-filled.
 * No API key or paid X API is involved.
 */
export function xIntentUrl(text: string, url: string): string {
  const params = new URLSearchParams({ text, url });
  return `https://x.com/intent/tweet?${params.toString()}`;
}

export function shareText(roomId: string): string {
  return roomId === WORLD_ROOM_ID
    ? 'Come play on the Timeline Games World Board ♟️ — grab a seat or watch live:'
    : 'Play me at chess ♟️ First to click gets the open seat — everyone else can watch live:';
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older/embedded browsers without the async clipboard API.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }
}

export function canNativeShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export async function nativeShare(title: string, text: string, url: string): Promise<boolean> {
  if (!canNativeShare()) return false;
  try {
    await navigator.share({ title, text, url });
    return true;
  } catch {
    return false; // Cancelled by the user, or not allowed here.
  }
}
