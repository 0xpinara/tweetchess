import { useEffect, useRef, useState } from 'react';
import { LOBBY_PROTOCOL_VERSION, type MatchmakingServerMessage } from '../../shared/lobby.ts';
import { CloseCode, type Color } from '../../shared/protocol.ts';
import { getDisplayName } from './display-name.ts';
import { getGuestToken } from './identity.ts';
import { useLiveSocket, wsUrl, type ConnectionStatus } from './live-socket.ts';

export type MatchmakingPhase = 'idle' | 'searching' | 'matched';

export interface FoundMatch {
  roomId: string;
  color: Color;
  opponent: string;
  resumed: boolean;
}

/** Remembers "I was searching" across a refresh, so the search resumes automatically. */
const SEARCHING_KEY = 'tweetchess.searching.v1';

function readSearching(): boolean {
  try {
    return sessionStorage.getItem(SEARCHING_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSearching(value: boolean): void {
  try {
    if (value) sessionStorage.setItem(SEARCHING_KEY, '1');
    else sessionStorage.removeItem(SEARCHING_KEY);
  } catch {
    // Not remembered.
  }
}

export function useMatchmaking(): {
  status: ConnectionStatus;
  phase: MatchmakingPhase;
  searching: number;
  match: FoundMatch | null;
  notice: string | null;
  fatal: string | null;
  find: () => void;
  cancel: () => void;
  retryNow: () => void;
} {
  const [phase, setPhase] = useState<MatchmakingPhase>(() => (readSearching() ? 'searching' : 'idle'));
  const [searching, setSearching] = useState(0);
  const [match, setMatch] = useState<FoundMatch | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const wantQueue = useRef(readSearching());
  const sendRef = useRef<(message: unknown) => boolean>(() => false);

  const socket = useLiveSocket({
    key: 'chess-matchmaking',
    url: () => wsUrl('/api/matchmaking/chess/ws'),
    hello: () => ({ type: 'hello', token: getGuestToken(), protocol: LOBBY_PROTOCOL_VERSION, name: getDisplayName() }),
    onMessage: (raw, control) => {
      const message = raw as MatchmakingServerMessage;
      switch (message.type) {
        case 'welcome':
          control.synced();
          setSearching(message.searching);
          // Rejoin the queue after a reconnect or refresh (the server dropped us when the socket closed).
          if (wantQueue.current) sendRef.current({ type: 'queue' });
          break;
        case 'queued':
          setSearching(message.searching);
          break;
        case 'cancelled':
          wantQueue.current = false;
          writeSearching(false);
          setPhase('idle');
          break;
        case 'matched':
          wantQueue.current = false;
          writeSearching(false);
          setMatch({ roomId: message.roomId, color: message.color, opponent: message.opponent, resumed: message.resumed });
          setPhase('matched');
          break;
        case 'error':
          if (message.code === 'unsupported_version') setFatal(message.message);
          else setNotice(message.message);
          break;
      }
    },
    fatalCodes: [CloseCode.UnsupportedVersion],
    onFatalClose: () => setFatal((previous) => previous ?? 'Timeline Games was updated. Please reload the page.'),
    slowRetryCodes: [CloseCode.Unavailable, CloseCode.RoomFull],
  });
  useEffect(() => {
    sendRef.current = socket.send;
  }, [socket.send]);

  const find = () => {
    wantQueue.current = true;
    writeSearching(true);
    setNotice(null);
    setPhase('searching');
    socket.send({ type: 'queue' });
  };

  const cancel = () => {
    wantQueue.current = false;
    writeSearching(false);
    setPhase('idle');
    socket.send({ type: 'cancel' });
  };

  return { status: socket.status, phase, searching, match, notice, fatal, find, cancel, retryNow: socket.retryNow };
}
