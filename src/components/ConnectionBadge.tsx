import { useEffect, useState } from 'react';
import type { ConnectionStatus } from '../lib/useRoom.ts';

const LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
  failed: 'Disconnected',
};

export function ConnectionBadge({
  status,
  retryAt,
  onRetry,
}: {
  status: ConnectionStatus;
  retryAt: number | null;
  onRetry: () => void;
}) {
  const seconds = useCountdown(retryAt);
  const showRetry = status === 'reconnecting' || status === 'offline';
  return (
    <div className={`connection connection-${status}`} role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      <span>
        {LABEL[status]}
        {showRetry && seconds !== null && seconds > 0 ? ` ${seconds}s` : ''}
      </span>
      {showRetry && (
        <button type="button" className="link-button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

function useCountdown(target: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (target === null) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [target]);
  return target === null ? null : Math.max(0, Math.ceil((target - now) / 1000));
}
