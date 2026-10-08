/**
 * A resilient WebSocket connection for one live page (chess room, poker
 * table, matchmaking). Handles:
 *  - reconnecting with exponential backoff and jitter,
 *  - a light heartbeat while the tab is visible (answered by the server
 *    runtime without waking the Durable Object) to spot dead connections,
 *  - dropping the socket when the device goes offline and resyncing on return,
 *  - giving up on "fatal" close codes (e.g. room not found).
 *
 * The caller decides what "in sync" means by calling `control.synced()`
 * when a full state arrives; that sets the status to "open".
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type ConnectionStatus =
  | 'connecting' // first attempt, nothing received yet
  | 'open' // connected and in sync with the server
  | 'reconnecting' // lost the connection, retrying with backoff
  | 'offline' // the browser reports no network
  | 'failed'; // will not retry (room not found, outdated app)

export interface LiveSocketControl {
  /** A full state arrived: the connection is live and in sync. */
  synced(): void;
}

export interface LiveSocketOptions {
  /** Changing the key starts a fresh connection. */
  key: string;
  url: () => string;
  /** First message on every connection. `reconnect` is true once this page has synced before. */
  hello: (reconnect: boolean) => unknown;
  onMessage: (message: unknown, control: LiveSocketControl) => void;
  /** Close codes after which we stop retrying. */
  fatalCodes?: readonly number[];
  onFatalClose?: (event: CloseEvent) => void;
  /** Close codes that mean "come back much later" (e.g. quota exhausted). */
  slowRetryCodes?: readonly number[];
  /** Set false to keep the hook idle (no connection). */
  enabled?: boolean;
}

export interface LiveSocket {
  status: ConnectionStatus;
  /** When the next reconnect attempt happens (ms epoch), if one is scheduled. */
  retryAt: number | null;
  /** Changes every time a (re)connection syncs, so callers can drop stale optimistic UI. */
  syncId: number;
  send: (message: unknown) => boolean;
  retryNow: () => void;
}

const HEARTBEAT_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
const SLOW_RETRY_MS = 60_000;

export function backoffDelay(attempt: number, random = Math.random()): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.max(0, attempt - 1));
  // "Equal jitter": half fixed, half random, so many clients don't reconnect in lockstep.
  return Math.round(ceiling / 2 + (random * ceiling) / 2);
}

export function wsUrl(path: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}

export function useLiveSocket(options: LiveSocketOptions): LiveSocket {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [syncId, setSyncId] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<() => void>(() => {});
  // Callbacks change every render; the connection reads the latest ones.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const enabled = options.enabled !== false;
  const { key } = options;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let pongTimer: ReturnType<typeof setTimeout> | undefined;
    let failed = false; // set after a fatal close; nothing reconnects after that
    let everSynced = false;
    let syncedSocket: WebSocket | null = null;

    const stopHeartbeat = () => {
      clearInterval(heartbeatTimer);
      clearTimeout(pongTimer);
      heartbeatTimer = undefined;
      pongTimer = undefined;
    };

    /** Forget a socket without waiting for a close handshake that may never come. */
    const abandon = (socket: WebSocket) => {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      if (socketRef.current === socket) socketRef.current = null;
      if (socket.readyState === WebSocket.CONNECTING) {
        // Closing mid-handshake logs a browser warning; close as soon as it opens instead.
        socket.onopen = () => socket.close(1000, 'abandoned');
        return;
      }
      try {
        socket.close(1000, 'abandoned');
      } catch {
        // Already closed.
      }
    };

    const ping = (socket: WebSocket) => {
      if (socket.readyState !== WebSocket.OPEN || pongTimer) return;
      socket.send('ping');
      pongTimer = setTimeout(() => {
        // No pong: the connection is dead even though the browser hasn't noticed.
        pongTimer = undefined;
        abandon(socket);
        stopHeartbeat();
        scheduleReconnect(0);
      }, PONG_TIMEOUT_MS);
    };

    const startHeartbeat = (socket: WebSocket) => {
      stopHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (document.visibilityState === 'visible') ping(socket);
      }, HEARTBEAT_MS);
    };

    const scheduleReconnect = (delayOverride?: number) => {
      if (disposed) return;
      clearTimeout(retryTimer);
      attempt += 1;
      const delay = delayOverride ?? backoffDelay(attempt);
      setStatus(navigator.onLine === false ? 'offline' : 'reconnecting');
      setRetryAt(Date.now() + delay);
      retryTimer = setTimeout(connect, delay);
    };

    function connect() {
      if (disposed) return;
      clearTimeout(retryTimer);
      setRetryAt(null);
      if (socketRef.current) abandon(socketRef.current);

      let socket: WebSocket;
      try {
        socket = new WebSocket(optionsRef.current.url());
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      const control: LiveSocketControl = {
        synced() {
          if (socketRef.current !== socket) return;
          attempt = 0;
          everSynced = true;
          if (syncedSocket !== socket) {
            syncedSocket = socket;
            setSyncId((value) => value + 1);
          }
          setStatus('open');
          setRetryAt(null);
        },
      };

      socket.onopen = () => {
        socket.send(JSON.stringify(optionsRef.current.hello(everSynced)));
        startHeartbeat(socket);
      };
      socket.onmessage = (event) => {
        if (event.data === 'pong') {
          clearTimeout(pongTimer);
          pongTimer = undefined;
          return;
        }
        if (typeof event.data !== 'string') return;
        let message: unknown;
        try {
          message = JSON.parse(event.data);
        } catch {
          return; // Ignore malformed frames.
        }
        optionsRef.current.onMessage(message, control);
      };
      socket.onclose = (event) => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        stopHeartbeat();
        if (disposed) return;
        const { fatalCodes = [], slowRetryCodes = [], onFatalClose } = optionsRef.current;
        if (fatalCodes.includes(event.code)) {
          failed = true;
          setStatus('failed');
          onFatalClose?.(event);
          return;
        }
        scheduleReconnect(slowRetryCodes.includes(event.code) ? SLOW_RETRY_MS : undefined);
      };
      socket.onerror = () => {
        // A close event always follows; reconnection is handled there.
      };
    }

    const reconnectSoon = () => {
      if (disposed || failed) return;
      const socket = socketRef.current;
      if (!socket) {
        attempt = 0;
        connect();
      } else if (socket.readyState === WebSocket.OPEN) {
        ping(socket); // verify the connection is really alive
      }
    };
    reconnectRef.current = reconnectSoon;

    const onVisibility = () => {
      if (document.visibilityState === 'visible') reconnectSoon();
    };
    // When the device loses its network, drop the socket (it is probably dead)
    // and resync from scratch once the 'online' event fires.
    const onOffline = () => {
      if (disposed || failed) return;
      if (socketRef.current) abandon(socketRef.current);
      stopHeartbeat();
      scheduleReconnect();
    };

    window.addEventListener('online', reconnectSoon);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    connect();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      stopHeartbeat();
      window.removeEventListener('online', reconnectSoon);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
      if (socketRef.current) abandon(socketRef.current);
    };
  }, [key, enabled]);

  const send = useCallback((message: unknown): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const retryNow = useCallback(() => reconnectRef.current(), []);

  return { status, retryAt, syncId, send, retryNow };
}
