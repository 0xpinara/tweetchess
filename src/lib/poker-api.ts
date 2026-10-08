async function post(path: string, fallback: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST' });
  } catch {
    throw new Error('Could not reach Timeline Games. Check your connection and try again.');
  }
  const body = (await response.json().catch(() => null)) as { tableId?: string; message?: string } | null;
  if (!response.ok || !body?.tableId) throw new Error(body?.message ?? `${fallback} (error ${response.status}).`);
  return body.tableId;
}

/** A public table with a free seat (or a new one). */
export function findPokerTable(): Promise<string> {
  return post('/api/poker/find', 'Could not find a table');
}

/** A new private table for friends. */
export function createPrivateTable(): Promise<string> {
  return post('/api/poker/tables', 'Could not create a table');
}

/** Pot-based raise sizes as "raise to" totals, clamped to what's allowed. */
export function raisePresets(options: { pot: number; currentBet: number; toCall: number; min: number; max: number }) {
  const { pot, currentBet, toCall, min, max } = options;
  const clamp = (value: number) => Math.max(min, Math.min(max, Math.round(value)));
  const potAfterCall = pot + toCall;
  return {
    min,
    half: clamp(currentBet + potAfterCall / 2),
    pot: clamp(currentBet + potAfterCall),
    max,
  };
}
