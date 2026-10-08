import { useRef, useState } from 'react';
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
import { getDisplayName } from './display-name.ts';
import { getGuestToken } from './identity.ts';
import { useLiveSocket, wsUrl, type ConnectionStatus } from './live-socket.ts';
import { hasLeftRoom } from './seat-memory.ts';

export { backoffDelay, type ConnectionStatus } from './live-socket.ts';

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

export function socketUrl(roomId: string): string {
  return wsUrl(`/api/rooms/${encodeURIComponent(roomId)}/ws`);
}

/**
 * Live connection to one chess room (the page remounts it per room via a React key).
 * `autoSit: false` (watch links) never takes a free seat, so spectating can't change who plays.
 */
export function useRoom(roomId: string, options: { autoSit?: boolean } = {}): RoomConnection {
  const autoSit = options.autoSit !== false;
  const [state, setState] = useState<RoomSnapshot | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [notice, setNotice] = useState<RoomNotice | null>(null);
  const [fatal, setFatal] = useState<RoomConnection['fatal']>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const noticeId = useRef(0);

  const socket = useLiveSocket({
    key: roomId,
    url: () => socketUrl(roomId),
    // Only a fresh visit may be seated automatically (and not if you chose to leave).
    hello: (reconnect) => ({
      type: 'hello',
      token: getGuestToken(),
      protocol: PROTOCOL_VERSION,
      sit: autoSit && !reconnect && !hasLeftRoom(roomId),
      name: getDisplayName(),
    }),
    onMessage: (raw, control) => {
      const message = raw as ServerMessage;
      switch (message.type) {
        case 'state':
          control.synced();
          setState(message.state);
          setRole(message.you);
          setReceivedAt(Date.now());
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
            noticeId.current += 1;
            setNotice({ id: noticeId.current, code: message.code, message: message.message });
          }
          break;
      }
    },
    fatalCodes: FATAL_CLOSE_CODES,
    onFatalClose: (event) =>
      setFatal(
        (previous) =>
          previous ?? {
            code: event.code === CloseCode.RoomNotFound ? 'room_not_found' : 'unsupported_version',
            message: event.reason || 'Connection closed.',
          },
      ),
    slowRetryCodes: [CloseCode.Unavailable],
  });

  return {
    status: socket.status,
    state,
    role,
    notice,
    fatal,
    retryAt: socket.retryAt,
    syncId: socket.syncId,
    receivedAt,
    send: socket.send as (message: ClientMessage) => boolean,
    retryNow: socket.retryNow,
  };
}
