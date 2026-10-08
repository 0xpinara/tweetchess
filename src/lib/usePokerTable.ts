import { useRef, useState } from 'react';
import {
  POKER_PROTOCOL_VERSION,
  type PlayerView,
  type PokerClientMessage,
  type PokerErrorCode,
  type PokerServerMessage,
  type PublicTable,
} from '../../shared/poker.ts';
import { CloseCode, FATAL_CLOSE_CODES } from '../../shared/protocol.ts';
import { getDisplayName } from './display-name.ts';
import { getGuestToken } from './identity.ts';
import { useLiveSocket, wsUrl, type ConnectionStatus } from './live-socket.ts';

export interface PokerNotice {
  id: number;
  code: PokerErrorCode;
  message: string;
}

export interface PokerConnection {
  status: ConnectionStatus;
  table: PublicTable | null;
  you: PlayerView | null;
  notice: PokerNotice | null;
  fatal: { code: string; message: string } | null;
  retryAt: number | null;
  /** Local time when the latest state arrived (countdowns run from here). */
  receivedAt: number;
  send: (message: PokerClientMessage) => boolean;
  retryNow: () => void;
}

/**
 * Live connection to one poker table. `autoSit` takes a free seat on the
 * first connection (used by Find a table / Create table); otherwise the
 * visitor watches until they pick a seat.
 */
export function usePokerTable(tableId: string, options: { autoSit?: boolean } = {}): PokerConnection {
  const autoSit = Boolean(options.autoSit);
  const [table, setTable] = useState<PublicTable | null>(null);
  const [you, setYou] = useState<PlayerView | null>(null);
  const [notice, setNotice] = useState<PokerNotice | null>(null);
  const [fatal, setFatal] = useState<PokerConnection['fatal']>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const noticeId = useRef(0);

  const socket = useLiveSocket({
    key: `poker:${tableId}`,
    url: () => wsUrl(`/api/poker/tables/${encodeURIComponent(tableId)}/ws`),
    hello: (reconnect) => ({
      type: 'hello',
      token: getGuestToken(),
      protocol: POKER_PROTOCOL_VERSION,
      name: getDisplayName(),
      sit: autoSit && !reconnect,
    }),
    onMessage: (raw, control) => {
      const message = raw as PokerServerMessage;
      if (message.type === 'state') {
        control.synced();
        setTable(message.table);
        setYou(message.you);
        setReceivedAt(Date.now());
      } else if (message.code === 'table_not_found' || message.code === 'unsupported_version') {
        setFatal({ code: message.code, message: message.message });
      } else {
        noticeId.current += 1;
        setNotice({ id: noticeId.current, code: message.code, message: message.message });
      }
    },
    fatalCodes: FATAL_CLOSE_CODES,
    onFatalClose: (event) =>
      setFatal(
        (previous) =>
          previous ?? {
            code: event.code === CloseCode.RoomNotFound ? 'table_not_found' : 'unsupported_version',
            message: event.reason || 'Connection closed.',
          },
      ),
    slowRetryCodes: [CloseCode.Unavailable],
  });

  return {
    status: socket.status,
    table,
    you,
    notice,
    fatal,
    retryAt: socket.retryAt,
    receivedAt,
    send: socket.send as (message: PokerClientMessage) => boolean,
    retryNow: socket.retryNow,
  };
}
