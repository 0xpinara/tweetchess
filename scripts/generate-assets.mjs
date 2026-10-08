/**
 * Generates the static link-preview image (public/og-image.png, 1200×600 —
 * the 2:1 ratio X uses for summary_large_image cards) and the favicon.
 *
 *   npm run generate:assets
 *
 * Requires Playwright's Chromium: npx playwright install chromium
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Chess } from 'chess.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultPieces } from 'react-chessboard';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

// The Italian Game after 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 — last move Bc4 highlighted.
const FEN = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
const HIGHLIGHT = new Set(['f1', 'c4']);

const piece = (color, type) => renderToStaticMarkup(defaultPieces[`${color}${type.toUpperCase()}`]());

function boardHtml() {
  const rows = new Chess(FEN).board();
  let html = '';
  rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      const square = `${'abcdefgh'[c]}${8 - r}`;
      const light = (r + c) % 2 === 0;
      const classes = ['sq', light ? 'light' : 'dark', HIGHLIGHT.has(square) ? 'hl' : ''].join(' ');
      html += `<div class="${classes}">${cell ? piece(cell.color, cell.type) : ''}</div>`;
    });
  });
  return html;
}

const ogHtml = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1200px; height: 600px; overflow: hidden;
    font-family: -apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif;
    color: #e8edf3;
    background:
      radial-gradient(700px 420px at 92% 10%, rgba(29,155,240,.28), transparent 60%),
      radial-gradient(600px 400px at 0% 100%, rgba(0,186,124,.14), transparent 60%),
      #0a0d12;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 70px 0 72px;
  }
  .copy { width: 560px; display: flex; flex-direction: column; gap: 26px; }
  .brand { display: flex; align-items: center; gap: 16px; font-size: 34px; font-weight: 800; letter-spacing: -0.02em; }
  .mark { width: 58px; height: 58px; border-radius: 16px; background: linear-gradient(135deg,#1d9bf0,#0b6fb5);
    display: grid; place-items: center; box-shadow: 0 8px 24px rgba(29,155,240,.4); }
  .mark svg { width: 46px; height: 46px; }
  h1 { font-size: 64px; line-height: 1.02; letter-spacing: -0.04em; font-weight: 850; }
  h1 span { background: linear-gradient(90deg,#4fb8ff,#1d9bf0 45%,#00ba7c); -webkit-background-clip: text; color: transparent; }
  p { font-size: 27px; color: #a6b3c1; line-height: 1.35; }
  .chips { display: flex; gap: 12px; }
  .chip { padding: 9px 18px; border-radius: 999px; font-size: 21px; font-weight: 700;
    background: rgba(29,155,240,.14); border: 1px solid rgba(29,155,240,.4); color: #9dd6fd; }
  .board { width: 470px; height: 470px; display: grid; grid-template-columns: repeat(8, 1fr);
    border-radius: 14px; overflow: hidden;
    box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 30px 70px rgba(0,0,0,.6), 0 0 90px rgba(29,155,240,.25); }
  .sq { position: relative; }
  .sq svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .light { background: #dee3e6; } .dark { background: #8ca2ad; }
  .hl::before { content: ''; position: absolute; inset: 0; background: rgba(255,200,40,.42); }
</style></head><body>
  <div class="copy">
    <div class="brand"><div class="mark">${piece('w', 'n')}</div>TweetChess</div>
    <h1>Live chess you can <span>share in a post.</span></h1>
    <p>Tap the link to take the open seat.<br>Everyone else watches live.</p>
    <div class="chips"><span class="chip">Free</span><span class="chip">No sign-up</span><span class="chip">Real-time</span></div>
  </div>
  <div class="board">${boardHtml()}</div>
</body></html>`;

// Favicon: the white knight on the brand-blue tile.
const knight = piece('w', 'n').replace('<svg', '<svg x="7" y="6" width="50" height="50"');
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d9bf0"/><stop offset="1" stop-color="#0b6fb5"/></linearGradient></defs>
  <rect width="64" height="64" rx="15" fill="url(#g)"/>
  ${knight}
</svg>
`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 600 }, deviceScaleFactor: 1 });
  await page.setContent(ogHtml, { waitUntil: 'load' });
  await page.screenshot({ path: `${publicDir}og-image.png`, type: 'png' });
} finally {
  await browser.close();
}
await writeFile(`${publicDir}favicon.svg`, favicon);
console.log('Wrote public/og-image.png (1200x600) and public/favicon.svg');
