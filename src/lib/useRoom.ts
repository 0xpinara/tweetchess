import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CloseCode,
  FATAL_CLOSE_CODES,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type Role,
  type RoomSnapshot,
  type ServerMessage,
} from '../../shared/protocol.ts';
import { getGuestToken } from './identity.ts';
import { hasLeftRoom } from './seat-memory.ts';

export type ConnectionStatus =
  | 'connecting' // first attempt, nothing received yet
  | 'open' // connected and in sync with the server
  | 'reconnecting' // lost the connection, retrying with backoff
  | 'offline' // the browser reports no network
  | 'failed'; // will not retry (room not found, outdated app)

export interface RoomNotice {
  id: number;
  code: ErrorCode;
  message: string;
}

export interface RoomConnection {
  status: ConnectionStatus;
  state: RoomSnapshot | null;
  role: Role | null;
  /** Last non-fatal server error, e.g. an illegal or stale move. */
  notice: RoomNotice | null;
  /** Why the connection gave up, when status is 'failed'. */
  fatal: { code: string; message: string } | null;
  /** When the next reconnect attempt happens (ms epoch), if one is scheduled. */
  retryAt: number | null;
  /** Changes every time a (re)connection syncs, so callers can drop stale optimistic UI. */
  syncId: number;
  /** Local time (ms) when the latest state arrived; countdowns run from here. */
  receivedAt: number;
  send: (message: ClientMessage) => boolean;
  retryNow: () => void;
}

/** Heartbeat only while the tab is visible; answered by the server runtime without waking the room. */
const HEARTBEAT_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
const UNAVAILABLE_BACKOFF_MS = 60_000;

export function socketUrl(roomId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/rooms/${encodeURIComponent(roomId)}/ws`;
}

export function backoffDelay(attempt: number, random = Math.random()): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.max(0, attempt - 1));
  // "Equal jitter": half fixed, half random, so many clients don't reconnect in lockstep.
  return Math.round(ceiling / 2 + (random * ceiling) / 2);
}

export function useRoom(roomId: string): RoomConnection {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [state, setState] = useState<RoomSnapshot | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [notice, setNotice] = useState<RoomNotice | null>(null);
  const [fatal, setFatal] = useState<RoomConnection['fatal']>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [syncId, setSyncId] = useState(0);
  const [receivedAt, setReceivedAt] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let pongTimer: ReturnType<typeof setTimeout> | undefined;
    let noticeId = 0;
    let failed = false; // set after a fatal close; nothing should reconnect after that
    let everSynced = false; // after the first sync, reconnects never grab a free seat
    // The page remounts this hook (via a React key) for every room, so state starts fresh.

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

    let syncedSocket: WebSocket | null = null;

    const handleMessage = (socket: WebSocket, message: ServerMessage) => {
      switch (message.type) {
        case 'state':
          attempt = 0;
          everSynced = true;
          if (syncedSocket !== socket) {
            syncedSocket = socket;
            setSyncId((value) => value + 1);
          }
          setState(message.state);
          setRole(message.you);
          setReceivedAt(Date.now());
          setStatus('open');
          setRetryAt(null);
          break;
        case 'presence':
          setState((previous) =>
            previous ? { ...previous, seats: message.seats, spectators: message.spectators } : previous,
          );
          break;
        case 'error':
          if (message.code === 'room_not_found' || message.code === 'unsupported_version') {
            setFatal({ code: message.code, message: message.message });
          } else {
            noticeId += 1;
            setNotice({ id: noticeId, code: message.code, message: message.message });
          }
          break;
      }
    };

    function connect() {
      if (disposed) return;
      clearTimeout(retryTimer);
      setRetryAt(null);
      if (socketRef.current) abandon(socketRef.current);

      let socket: WebSocket;
      try {
        socket = new WebSocket(socketUrl(roomId));
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        // Only a fresh visit may be seated automatically (and not if you chose to leave).
        const sit = !everSynced && !hasLeftRoom(roomId);
        socket.send(JSON.stringify({ type: 'hello', token: getGuestToken(), protocol: PROTOCOL_VERSION, sit }));
        startHeartbeat(socket);
      };
      socket.onmessage = (event) => {
        if (event.data === 'pong') {
          clearTimeout(pongTimer);
          pongTimer = undefined;
          return;
        }
        if (typeof event.data !== 'string') return;
        try {
          handleMessage(socket, JSON.parse(event.data) as ServerMessage);
        } catch {
          // Ignore malformed frames.
        }
      };
      socket.onclose = (event) => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        stopHeartbeat();
        if (disposed) return;
        if (FATAL_CLOSE_CODES.includes(event.code)) {
          failed = true;
          setStatus('failed');
          setFatal(
            (previous) =>
              previous ?? {
                code: event.code === CloseCode.RoomNotFound ? 'room_not_found' : 'unsupported_version',
                message: event.reason || 'Connection closed.',
              },
          );
          return;
        }
        scheduleReconnect(event.code === CloseCode.Unavailable ? UNAVAILABLE_BACKOFF_MS : undefined);
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
    // When the device loses its network, drop the socket (it is probably dead) and
    // resync from scratch once the 'online' event fires.
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
  }, [roomId]);

  const send = useCallback((message: ClientMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const retryNow = useCallback(() => reconnectRef.current(), []);

  return { status, state, role, notice, fatal, retryAt, syncId, receivedAt, send, retryNow };
}
