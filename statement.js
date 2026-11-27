'use strict';
// The score sheet for a night: one player's chips, as a PDF. It says what he took, what he
// finished with and the difference, with his chips hand by hand - and nothing about anybody
// else, or between one player and another. No dependencies: the PDF is written by hand.

// one row per session the player was part of: chips at the start, at the end, and what they won or lost
// (chips added by the banker during the session are not counted as winnings)
// ---- tiny PDF writer ----
const W_ = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const clean = (s) => String(s == null ? '' : s).replace(/[−–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7e]/g, '?');
const textW = (s, size, bold) => { let w = 0; for (const ch of clean(s)) w += W_[ch.charCodeAt(0) - 32] || 556; return w * size / 1000 * (bold ? 1.06 : 1); };
const esc = (s) => clean(s).replace(/[\\()]/g, '\\$&');
const hex = (h) => [1, 3, 5].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');

class Doc {
  constructor(footer) { this.pages = []; this.footer = footer; this.newPage(); }
  newPage() { this.ops = []; this.pages.push(this.ops); this.y = 842 - 48; }
  op(s) { this.ops.push(s); }
  rect(x, y, w, h, fill) { this.op(`${hex(fill)} rg ${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f`); }
  line(x1, y1, x2, y2, col, wd, dash) { this.op(`${hex(col)} RG ${wd || 0.6} w ${dash ? '[3 3] 0 d' : '[] 0 d'} ${x1.toFixed(1)} ${y1.toFixed(1)} m ${x2.toFixed(1)} ${y2.toFixed(1)} l S`); }
  text(s, x, y, size, col, o = {}) {
    const w = textW(s, size, o.bold);
    const px = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    this.op(`BT /${o.bold ? 'F2' : 'F1'} ${size} Tf ${hex(col)} rg ${px.toFixed(1)} ${y.toFixed(1)} Td (${esc(s)}) Tj ET`);
  }
  need(h) { if (this.y - h < 56) this.newPage(); }
  build() {
    const objs = [];
    const add = (s) => { objs.push(s); return objs.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(null); // pages, filled below
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    this.pages.forEach((ops, i) => {
      const foot = `BT /F1 8 Tf ${hex('#8a928c')} rg 40 28 Td (${esc(this.footer)}) Tj ET BT /F1 8 Tf ${hex('#8a928c')} rg 555 28 Td (Page ${i + 1} of ${this.pages.length}) Tj ET BT /F1 7 Tf ${hex('#8a928c')} rg 40 17 Td (Copyright 2026 Vashanth Somasundaram. All rights reserved.) Tj ET`;
      const stream = ops.join('\n') + '\n' + foot;
      const c = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
      const p = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${c} 0 R >>`);
      kids.push(p + ' 0 R');
    });
    objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
    let out = '%PDF-1.4\n'; const offs = [];
    objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

const INK = '#1b201d', MUTED = '#6b736d', GOLD = '#b58a2a', GOLDL = '#d8b45c', DARK = '#0f1311', LINE = '#d9ddd9', RED = '#b3363d', GREEN = '#2c7a4b', PALE = '#f3f1ea';
const fmt = (n) => Math.abs(Math.round(n)).toLocaleString('en-US');
const signed = (n) => (n > 0 ? '+' : n < 0 ? '-' : '') + fmt(n);

function stamp(ms, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(ms).replace(/\s?(am|pm)$/i, (m) => ' ' + m.trim().toUpperCase());
  } catch (e) { return new Date(ms).toISOString(); }
}
const dateOnly = (ms, tz) => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(ms); } catch (e) { return new Date(ms).toDateString(); } };
const timeOnly = (ms, tz) => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }).format(ms).toUpperCase(); } catch (e) { return ''; } };

function scoreSheetPdf(final, personId, tz) {
  tz = tz || process.env.STATEMENT_TZ || 'Asia/Kolkata';
  const me = final.people.find((p) => p.id === personId);
  if (!me) return null;
  const d = new Doc(`Smart Buddies  |  Room ${final.code}  |  ${me.name}  |  Times shown in ${tz}`);
  // header band
  d.rect(0, 842 - 118, 595, 118, DARK);
  d.text(final.live ? 'SMART BUDDIES  -  CHIP SCORE SO FAR' : 'SMART BUDDIES  -  CHIP SCORE SHEET', 40, 842 - 38, 9, GOLDL, { bold: true });
  d.text(me.name, 40, 842 - 76, 30, '#f2efe6', { bold: true });
  d.text('Room ID', 555, 842 - 38, 8, '#a3aba5', { align: 'right' });
  d.text(final.code, 555, 842 - 56, 18, GOLDL, { align: 'right', bold: true });
  d.text(dateOnly(final.at, tz), 555, 842 - 76, 10, '#f2efe6', { align: 'right' });
  d.text(`Blinds ${fmt(final.sb)}/${fmt(final.bb)}  -  ${final.sessions} session${final.sessions === 1 ? '' : 's'}`, 555, 842 - 92, 9, '#a3aba5', { align: 'right' });
  d.y = 842 - 118 - 26;

  // summary boxes
  const boxes = [[me.carried >= me.invested && me.invested > 0 ? 'STARTED WITH' : 'CHIPS TAKEN', fmt(me.invested), INK], [final.live ? 'CHIPS NOW' : 'FINAL CHIP COUNT', fmt(me.final), INK], [final.live ? (me.net >= 0 ? 'UP SO FAR' : 'DOWN SO FAR') : me.net >= 0 ? 'CHIPS UP' : 'CHIPS DOWN', signed(me.net), me.net > 0 ? GREEN : me.net < 0 ? RED : INK]];
  const bw = (515 - 20) / 3;
  boxes.forEach((b, i) => {
    const x = 40 + i * (bw + 10);
    d.rect(x, d.y - 56, bw, 56, PALE);
    d.text(b[0], x + 12, d.y - 18, 8, MUTED, { bold: true });
    d.text(b[1], x + 12, d.y - 44, 22, b[2], { bold: true });
  });
  d.y -= 56 + 26;

  const section = (title) => { d.need(40); d.text(title, 40, d.y, 9, GOLD, { bold: true }); d.line(40, d.y - 6, 555, d.y - 6, LINE, 0.6); d.y -= 22; };

  // chart
  d.need(210);
  section('CHIP STACK AFTER EACH HAND');
  // A finished game keeps everybody's chips hand by hand in one place - the record's curve -
  // rather than repeating them inside each person's row. Older records kept a history instead,
  // so both are read, the newer shape first.
  const hist = (me.history && me.history.length)
    ? me.history.filter((h) => h.stack != null)
    : (function () {
      // The curve is hand numbers and chips, nothing else - a time against every hand would be
      // half again as much to carry in the one file this portal keeps, for two labels. The two
      // the graph prints are the ones the record already knows: when the game started and when
      // it ended.
      const pts = ((final.curve || {})[me.id]) || [];
      return pts.map((pt, i) => ({
        no: pt[0], stack: pt[1],
        t: i === pts.length - 1 ? final.at : (final.startedAt || final.at),
      }));
    }());
  const cx = 40, cw = 515, ch = 130, cy = d.y - ch;
  d.rect(cx, cy, cw, ch, PALE);
  if (hist.length >= 2) {
    const vals = hist.map((h) => h.stack);
    let lo = Math.min(...vals), hi = Math.max(...vals); if (hi === lo) { hi += 1; lo -= 1; }
    const px = (i) => cx + 12 + (cw - 24) * i / (vals.length - 1), py = (v) => cy + 14 + (ch - 36) * (v - lo) / (hi - lo);
    d.line(cx + 12, py(vals[0]), cx + cw - 12, py(vals[0]), LINE, 0.5, true);
    let path = vals.map((v, i) => `${px(i).toFixed(1)} ${py(v).toFixed(1)} ${i ? 'l' : 'm'}`).join(' ');
    d.op(`${hex(INK)} RG 1.4 w [] 0 d ${path} S`);
    d.text('Low ' + fmt(lo), cx + 12, cy + 3, 8, MUTED); d.text('High ' + fmt(hi), cx + cw - 12, cy + 3, 8, MUTED, { align: 'right' });
    d.text('Start ' + timeOnly(hist[0].t, tz), cx + cw / 2 - 60, cy + 3, 8, MUTED, { align: 'center' });
    d.text('End ' + timeOnly(hist[hist.length - 1].t, tz), cx + cw / 2 + 60, cy + 3, 8, MUTED, { align: 'center' });
  } else d.text('Not enough hands played to draw a graph.', cx + cw / 2, cy + ch / 2, 10, MUTED, { align: 'center' });
  d.y = cy - 26;

  // buy-in timings
  section('CHIPS TAKEN AND RETURNED');
  d.text('DATE AND TIME', 40, d.y, 7.5, MUTED, { bold: true }); d.text('ENTRY', 190, d.y, 7.5, MUTED, { bold: true }); d.text('CHIPS', 555, d.y, 7.5, MUTED, { bold: true, align: 'right' }); d.y -= 14;
  me.ledger.forEach((l) => {
    d.need(18);
    const label = l.kind === 'buyin' ? (l.by === 'carried over' ? 'Chips carried over from the last game' : 'Chips taken') : l.kind === 'cashout' ? 'Chips returned' : 'Chip adjustment' + (l.reason ? ' - ' + l.reason : '');
    d.text(stamp(l.t, tz), 40, d.y, 9.5, INK); d.text(label, 190, d.y, 9.5, INK);
    d.text(signed(l.amount), 555, d.y, 9.5, l.amount < 0 ? RED : INK, { align: 'right' });
    d.line(40, d.y - 5, 555, d.y - 5, LINE, 0.3); d.y -= 16;
  });
  d.need(30);
  d.line(40, d.y + 6, 555, d.y + 6, INK, 0.8); d.y -= 8;
  d.text(me.carried >= me.invested && me.invested > 0 ? 'Total chips (carried over)' : 'Total chips taken', 190, d.y, 9.5, INK, { bold: true }); d.text(fmt(me.invested), 555, d.y, 9.5, INK, { align: 'right', bold: true }); d.y -= 16;
  d.text(final.live ? 'Chips now' : 'Final chip count', 190, d.y, 9.5, INK, { bold: true }); d.text(fmt(me.final), 555, d.y, 9.5, INK, { align: 'right', bold: true }); d.y -= 20;
  d.need(30);
  d.text('Played with virtual chips, for recreation among friends. Chips have no money value and cannot be bought,', 40, d.y, 8, MUTED); d.y -= 11;
  d.text('sold or cashed through the portal. This sheet is a chip score and nothing else.', 40, d.y, 8, MUTED); d.y -= 11;
  d.text('The app developer and the portal admin are not liable for what players do outside the game.', 40, d.y, 8, MUTED);
  return d.build();
}

module.exports = { scoreSheetPdf };
