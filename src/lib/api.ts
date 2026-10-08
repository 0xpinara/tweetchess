/**
 * Ask the server for a brand-new friend game. Returns its ID.
 * `listed: true` also shows it in the public live-games directory.
 */
export async function createRoom(options: { listed?: boolean } = {}): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listed: Boolean(options.listed) }),
    });
  } catch {
    throw new Error('Could not reach Timeline Games. Check your connection and try again.');
  }
  const body = (await response.json().catch(() => null)) as { roomId?: string; message?: string } | null;
  if (!response.ok || !body?.roomId) {
    throw new Error(body?.message ?? `Could not create a game (error ${response.status}). Please try again.`);
  }
  return body.roomId;
}
