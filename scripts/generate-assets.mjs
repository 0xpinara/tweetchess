/**
 * Generates the static link-preview images (1200×600 — the 2:1 ratio X uses
 * for summary_large_image cards) and the favicon:
 *   public/og-image.png  homepage, Live and other pages (chess and poker)
 *   public/og-chess.png  chess invites, matchmaking and the World Board
 *   public/og-poker.png  poker tables and the poker page
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

const card = (code) => {
  const rank = code[0] === 'T' ? '10' : code[0];
  const suit = { s: '♠', h: '♥', d: '♦', c: '♣' }[code[1]];
  return `<div class="card${'hd'.includes(code[1]) ? ' red' : ''}"><span>${rank}</span><span>${suit}</span></div>`;
};

/** One 1200×600 preview: brand and copy on the left, artwork on the right. */
const preview = ({ headline, lede, chips, art }) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1200px; height: 600px; overflow: hidden; position: relative;
    font-family: -apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif;
    color: #e8edf3;
    background:
      radial-gradient(700px 420px at 92% 10%, rgba(29,155,240,.28), transparent 60%),
      radial-gradient(600px 400px at 0% 100%, rgba(0,186,124,.14), transparent 60%),
      #0a0d12;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 70px 0 72px;
  }
  .copy { width: 560px; display: flex; flex-direction: column; gap: 26px; position: relative; z-index: 2; }
  .brand { display: flex; align-items: center; gap: 16px; font-size: 34px; font-weight: 800; letter-spacing: -0.02em; }
  .mark { width: 58px; height: 58px; border-radius: 16px; background: linear-gradient(135deg,#1d9bf0,#0b6fb5);
    display: grid; place-items: center; box-shadow: 0 8px 24px rgba(29,155,240,.4); }
  .mark svg { width: 46px; height: 46px; }
  h1 { font-size: 62px; line-height: 1.03; letter-spacing: -0.04em; font-weight: 850; }
  h1 span { background: linear-gradient(90deg,#4fb8ff,#1d9bf0 45%,#00ba7c); -webkit-background-clip: text; color: transparent; }
  p { font-size: 27px; color: #a6b3c1; line-height: 1.35; }
  .chips { display: flex; gap: 12px; }
  .chip { padding: 9px 18px; border-radius: 999px; font-size: 21px; font-weight: 700;
    background: rgba(29,155,240,.14); border: 1px solid rgba(29,155,240,.4); color: #9dd6fd; }
  .art { position: relative; width: 490px; height: 490px; display: grid; place-items: center; }
  .board { width: 470px; height: 470px; display: grid; grid-template-columns: repeat(8, 1fr);
    border-radius: 14px; overflow: hidden;
    box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 30px 70px rgba(0,0,0,.6), 0 0 90px rgba(29,155,240,.25); }
  .board.small { width: 400px; height: 400px; transform: rotate(4deg) translate(30px, -20px); }
  .sq { position: relative; }
  .sq svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .light { background: #dee3e6; } .dark { background: #8ca2ad; }
  .hl::before { content: ''; position: absolute; inset: 0; background: rgba(255,200,40,.42); }
  .card { --w: 92px; width: var(--w); height: calc(var(--w) * 1.4); border-radius: calc(var(--w) * .12);
    background: #fdfdfb; color: #17202a; display: grid; place-content: center; justify-items: center;
    font-weight: 800; line-height: 1; box-shadow: 0 2px 0 rgba(0,0,0,.25), 0 16px 34px rgba(0,0,0,.5); }
  .card.red { color: #d1202f; }
  .card span:first-child { font-size: calc(var(--w) * .44); letter-spacing: -.04em; }
  .card span:last-child { font-size: calc(var(--w) * .4); }
  .hand { position: absolute; display: flex; }
  .hand .card { --w: 118px; }
  .hand .card:first-child { transform: rotate(-9deg) translate(14px, 6px); }
  .hand .card:last-child { transform: rotate(7deg) translate(-14px, 0); }
  .over-board { left: -26px; bottom: -6px; }
  .felt { width: 490px; height: 340px; border-radius: 50%; border: 14px solid #5a3a22;
    background: radial-gradient(ellipse at center, #23855a 0%, #176240 55%, #0f452c 100%);
    box-shadow: inset 0 0 50px rgba(0,0,0,.45), 0 0 0 3px #2c1c10, 0 30px 70px rgba(0,0,0,.6);
    display: grid; place-content: center; justify-items: center; gap: 14px; transform: translateY(-40px); }
  .board-cards { display: flex; gap: 8px; }
  .board-cards .card { --w: 64px; }
  .pot { padding: 6px 18px; border-radius: 999px; background: rgba(0,0,0,.35); color: #fff; font-size: 22px; font-weight: 800; }
  .below-felt { bottom: 6px; left: 50%; transform: translateX(-50%); }
  .chipstack { position: absolute; display: grid; }
  .pchip { width: 64px; height: 18px; margin-top: -8px; border-radius: 50%; border: 3px dashed #fff;
    background: #e0454f; box-shadow: 0 3px 0 #9e2a32; }
  .pchip.blue { background: #1d9bf0; box-shadow: 0 3px 0 #0b5e9a; }
</style></head><body>
  <div class="copy">
    <div class="brand"><div class="mark">${piece('w', 'n')}</div>Timeline Games</div>
    <h1>${headline}</h1>
    <p>${lede}</p>
    <div class="chips">${chips.map((chip) => `<span class="chip">${chip}</span>`).join('')}</div>
  </div>
  <div class="art">${art}</div>
</body></html>`;

const chipStack = (style, colors) =>
  `<div class="chipstack" style="${style}">${colors.map((c) => `<div class="pchip ${c}"></div>`).join('')}</div>`;

const images = {
  // Homepage, Live and anything without its own image.
  'og-image.png': preview({
    headline: 'Chess and poker with <span>your timeline.</span>',
    lede: 'Find a match, invite friends with a link,<br>or watch games live.',
    chips: ['Free', 'No sign-up', 'Play money only'],
    art: `<div class="board small">${boardHtml()}</div>
      <div class="hand over-board">${card('As')}${card('Kh')}</div>
      ${chipStack('right: 0; bottom: 10px;', ['blue', '', 'blue', ''])}`,
  }),
  'og-chess.png': preview({
    headline: 'Live chess you can <span>share in a post.</span>',
    lede: 'Tap the link to take the open seat.<br>Everyone else watches live.',
    chips: ['Free', 'No sign-up', 'Real-time'],
    art: `<div class="board">${boardHtml()}</div>`,
  }),
  'og-poker.png': preview({
    headline: "Texas Hold'em with <span>your timeline.</span>",
    lede: 'Take a seat or just watch. 2–6 players,<br>free play-money chips.',
    chips: ['Free', 'No sign-up', 'Play money only'],
    art: `<div class="felt"><div class="board-cards">${['Kh', '9c', '4d', 'Js', '2h'].map(card).join('')}</div>
        <div class="pot">Pot 240</div></div>
      <div class="hand below-felt">${card('As')}${card('Ad')}</div>
      ${chipStack('left: 8px; bottom: 40px;', ['', 'blue', '', 'blue', ''])}`,
  }),
};

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
  for (const [file, html] of Object.entries(images)) {
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path: `${publicDir}${file}`, type: 'png' });
  }
} finally {
  await browser.close();
}
await writeFile(`${publicDir}favicon.svg`, favicon);
console.log(`Wrote ${Object.keys(images).map((file) => `public/${file}`).join(', ')} (1200x600) and public/favicon.svg`);
