/** Ask the server for a brand-new private room. Returns its ID. */
export async function createRoom(): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/api/rooms', { method: 'POST' });
  } catch {
    throw new Error('Could not reach TweetChess. Check your connection and try again.');
  }
  const body = (await response.json().catch(() => null)) as { roomId?: string; message?: string } | null;
  if (!response.ok || !body?.roomId) {
    throw new Error(body?.message ?? `Could not create a game (error ${response.status}). Please try again.`);
  }
  return body.roomId;
}
