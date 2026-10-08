import { useCallback, useEffect, useState } from 'react';
import type { LiveFilter, LiveGame, LivePage, LiveGameType } from '../../shared/lobby.ts';

export type LiveScope = LiveGameType | 'all';

const POLL_MS = 20_000;

export async function fetchLive(scope: LiveScope, filter: LiveFilter, cursor: string | null = null): Promise<LivePage> {
  const params = new URLSearchParams({ game: scope, filter });
  if (cursor) params.set('cursor', cursor);
  const response = await fetch(`/api/live?${params.toString()}`);
  if (!response.ok) throw new Error(`Could not load live games (error ${response.status}).`);
  return (await response.json()) as LivePage;
}

interface LiveData {
  /** Which scope + filter this data belongs to. */
  key: string;
  first: LiveGame[];
  more: LiveGame[];
  next: string | null;
  updatedAt: number | null;
  error: string | null;
  loaded: boolean;
}

const empty = (key: string): LiveData => ({ key, first: [], more: [], next: null, updatedAt: null, error: null, loaded: false });

/**
 * Public live games, refreshed every 20 seconds while the page is visible
 * (and immediately when it becomes visible again). "Load more" appends pages.
 */
export function useLiveGames(scope: LiveScope, filter: LiveFilter) {
  const key = `${scope}|${filter}`;
  const [stored, setStored] = useState<LiveData>(() => empty(key));
  const [loadingMore, setLoadingMore] = useState(false);
  // Data for a previous filter is never shown for the current one.
  const data = stored.key === key ? stored : empty(key);

  const refresh = useCallback(async () => {
    try {
      const page = await fetchLive(scope, filter);
      setStored((previous) => {
        const same = previous.key === key;
        return {
          key,
          first: page.games,
          more: same ? previous.more : [],
          next: same && previous.more.length > 0 ? previous.next : page.nextCursor,
          updatedAt: Date.now(),
          error: null,
          loaded: true,
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not load live games.';
      setStored((previous) => (previous.key === key ? { ...previous, error: message } : { ...empty(key), error: message }));
    }
  }, [scope, filter, key]);

  useEffect(() => {
    // Loading from the server is the external sync this effect exists for;
    // state is only set after the request resolves.
    // oxlint-disable-next-line react/set-state-in-effect
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!data.next) return;
    setLoadingMore(true);
    try {
      const page = await fetchLive(scope, filter, data.next);
      setStored((previous) =>
        previous.key === key ? { ...previous, more: [...previous.more, ...page.games], next: page.nextCursor } : previous,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not load more games.';
      setStored((previous) => (previous.key === key ? { ...previous, error: message } : previous));
    } finally {
      setLoadingMore(false);
    }
  }, [scope, filter, key, data.next]);

  // A game can move between pages while polling; show each once.
  const seen = new Set<string>();
  const games = [...data.first, ...data.more].filter((game) => {
    const id = `${game.game}:${game.id}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const status: 'loading' | 'ready' | 'error' = data.loaded ? 'ready' : data.error ? 'error' : 'loading';

  return {
    games,
    status,
    error: data.error,
    updatedAt: data.updatedAt,
    nextCursor: data.next,
    loadingMore,
    refresh,
    loadMore,
  };
}
