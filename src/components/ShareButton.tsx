import { useEffect, useId, useRef, useState } from 'react';
import { canNativeShare, copyText, nativeShare, roomUrl, shareText, xIntentUrl } from '../lib/share.ts';

export function ShareButton({ roomId, variant = 'primary' }: { roomId: string; variant?: 'primary' | 'secondary' }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const panelId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const url = roomUrl(roomId);
  const text = shareText(roomId);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="share" ref={wrapperRef}>
      <button
        type="button"
        className={`btn ${variant === 'primary' ? 'btn-primary' : 'btn-secondary'} btn-small`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <ShareIcon /> Share
      </button>
      {open && (
        <div className="share-panel" id={panelId} role="group" aria-label="Share this game">
          <a className="btn btn-x" href={xIntentUrl(text, url)} target="_blank" rel="noopener noreferrer">
            <XLogo /> Post on X
          </a>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={async () => setCopied(await copyText(url))}
          >
            {copied ? 'Copied ✓' : 'Copy link'}
          </button>
          {canNativeShare() && (
            <button type="button" className="btn btn-secondary" onClick={() => nativeShare('TweetChess', text, url)}>
              More options…
            </button>
          )}
          <input
            className="share-url"
            readOnly
            value={url}
            aria-label="Game link"
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}
    </div>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v13" />
      <path d="m7 8 5-5 5 5" />
      <path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
    </svg>
  );
}

export function XLogo() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
