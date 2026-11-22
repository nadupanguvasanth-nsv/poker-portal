'use strict';
// Settlement and PDF account statements. No dependencies: the PDF is written by hand.

// ---- settlement: biggest loser pays biggest winner, and so on ----
function settle(rows) {
  const losers = rows.filter((r) => r.net < 0).map((r) => ({ id: r.id, name: r.name, left: -r.net })).sort((a, b) => b.left - a.left);
  const winners = rows.filter((r) => r.net > 0).map((r) => ({ id: r.id, name: r.name, left: r.net })).sort((a, b) => b.left - a.left);
  const transfers = [];
  let i = 0, j = 0;
  while (i < losers.length && j < winners.length) {
    const amt = Math.min(losers[i].left, winners[j].left);
    if (amt > 0) transfers.push({ from: losers[i].id, fromName: losers[i].name, to: winners[j].id, toName: winners[j].name, amount: amt });
    losers[i].left -= amt; winners[j].left -= amt;
    if (losers[i].left === 0) i++;
    if (winners[j].left === 0) j++;
    // keep the biggest-first order after a partial payment
    losers.sort((a, b) => (a.left === 0) - (b.left === 0) || b.left - a.left); i = losers.findIndex((x) => x.left > 0); if (i < 0) i = losers.length;
    winners.sort((a, b) => (a.left === 0) - (b.left === 0) || b.left - a.left); j = winners.findIndex((x) => x.left > 0); if (j < 0) j = winners.length;
  }
  return transfers;
}

// one row per session the player was part of: chips at the start, at the end, and what they won or lost
// (chips added by the banker during the session are not counted as winnings)
function sessionRows(sessLog, history, ledger, live) {
  const rows = [];
  const upto = (T) => { let e = null; for (const h of history) if (h.t <= T && h.kind !== 'cashout') e = h; return e; };
  (sessLog || []).forEach((s, i) => {
    const isLast = i === sessLog.length - 1, end = s.end || Date.now();
    const st = upto(s.start), startStack = st ? st.stack : 0;
    let e = history.find((h) => h.kind === 'deck' && h.session === s.no);
    if (!e && isLast && s.end) e = history.find((h) => h.kind === 'end');
    const ended = !!s.end;
    let endStack = e ? e.stack : (ended ? (upto(end) || { stack: 0 }).stack : live);
    if (!st && !history.some((h) => h.t <= end && h.t >= s.start) && !e) return; // not at the table in this session
    const added = ledger.filter((l) => l.kind !== 'cashout' && l.t > s.start && l.t <= end).reduce((a, l) => a + l.amount, 0);
    rows.push({ no: s.no, start: startStack, end: endStack, added, net: endStack - startStack - added, from: s.start, to: s.end || 0, live: !ended });
  });
  return rows;
}

// everybody who sat at the table: still seated, or cashed out earlier
function buildFinal(t) {
  const people = [];
  const add = (id, token, name, ledger, history, finalChips, isAdmin, memberId) => {
    const invested = ledger.filter((l) => l.kind !== 'cashout').reduce((s, l) => s + l.amount, 0);
    const bought = ledger.filter((l) => l.kind === 'buyin').reduce((s, l) => s + l.amount, 0);
    const carried = ledger.filter((l) => l.kind === 'buyin' && l.by === 'carried over').reduce((s, l) => s + l.amount, 0);
    people.push({ id, token, name, isAdmin, memberId, sessions: sessionRows(t.sessLog, history, ledger, finalChips), dl: require('crypto').randomBytes(18).toString('hex'), ledger: ledger.slice(), history: history.slice(), final: finalChips, invested, bought, carried, net: finalChips - invested });
  };
  for (const d of t.departed) add(d.id, d.token, d.name, d.ledger, d.history, d.amount, false, d.memberId);
  for (const p of t.players.values()) add(p.id, p.token, p.name, p.ledger, p.history, p.stack + p.queued, p.id === t.adminId, p.memberId);
  return { at: Date.now(), code: t.code, sessions: t.sessionNo, sb: t.settings.sb, bb: t.settings.bb, people, transfers: settle(people) };
}

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
      const foot = `BT /F1 8 Tf ${hex('#8a928c')} rg 40 28 Td (${esc(this.footer)}) Tj ET BT /F1 8 Tf ${hex('#8a928c')} rg 555 28 Td (Page ${i + 1} of ${this.pages.length}) Tj ET`;
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

function statementPdf(final, personId, tz) {
  tz = tz || process.env.STATEMENT_TZ || 'Asia/Kolkata';
  const me = final.people.find((p) => p.id === personId);
  if (!me) return null;
  const d = new Doc(`Smart Buddies  |  Room ${final.code}  |  ${me.name}  |  Times shown in ${tz}`);
  // header band
  d.rect(0, 842 - 118, 595, 118, DARK);
  d.text(final.live ? 'SMART BUDDIES  -  STATEMENT SO FAR' : 'SMART BUDDIES  -  ACCOUNT STATEMENT', 40, 842 - 38, 9, GOLDL, { bold: true });
  d.text(me.name, 40, 842 - 76, 30, '#f2efe6', { bold: true });
  d.text('Room ID', 555, 842 - 38, 8, '#a3aba5', { align: 'right' });
  d.text(final.code, 555, 842 - 56, 18, GOLDL, { align: 'right', bold: true });
  d.text(dateOnly(final.at, tz), 555, 842 - 76, 10, '#f2efe6', { align: 'right' });
  d.text(`Blinds ${fmt(final.sb)}/${fmt(final.bb)}  -  ${final.sessions} session${final.sessions === 1 ? '' : 's'}`, 555, 842 - 92, 9, '#a3aba5', { align: 'right' });
  d.y = 842 - 118 - 26;

  // summary boxes
  const boxes = [[me.carried >= me.invested && me.invested > 0 ? 'STARTED WITH' : 'TOTAL BOUGHT IN', fmt(me.invested), INK], [final.live ? 'CHIPS NOW' : 'FINAL CHIP COUNT', fmt(me.final), INK], [final.live ? (me.net >= 0 ? 'UP SO FAR' : 'DOWN SO FAR') : me.net >= 0 ? 'NET WON' : 'NET LOST', signed(me.net), me.net > 0 ? GREEN : me.net < 0 ? RED : INK]];
  const bw = (515 - 20) / 3;
  boxes.forEach((b, i) => {
    const x = 40 + i * (bw + 10);
    d.rect(x, d.y - 56, bw, 56, PALE);
    d.text(b[0], x + 12, d.y - 18, 8, MUTED, { bold: true });
    d.text(b[1], x + 12, d.y - 44, 22, b[2], { bold: true });
  });
  d.y -= 56 + 26;

  // settlement
  const section = (title) => { d.need(40); d.text(title, 40, d.y, 9, GOLD, { bold: true }); d.line(40, d.y - 6, 555, d.y - 6, LINE, 0.6); d.y -= 22; };
  if (!final.live) {
  section('SETTLEMENT');
  const mine = final.transfers.filter((x) => x.from === me.id || x.to === me.id);
  if (!mine.length) { d.text(me.net === 0 ? 'You finished even. Nothing to settle.' : 'Nothing to settle.', 40, d.y, 11, INK); d.y -= 20; }
  mine.forEach((x) => {
    d.need(24);
    const pay = x.from === me.id;
    d.text(pay ? `You pay ${x.toName}` : `${x.fromName} pays you`, 40, d.y, 12, INK, { bold: true });
    d.text((pay ? '-' : '+') + fmt(x.amount) + ' chips', 555, d.y, 12, pay ? RED : GREEN, { align: 'right', bold: true });
    d.y -= 20;
  });
  d.y -= 10;
  }

  // session by session
  if (me.sessions && me.sessions.length) {
    section('SESSION BY SESSION');
    d.text('SESSION', 40, d.y, 7.5, MUTED, { bold: true }); d.text('STARTED WITH', 240, d.y, 7.5, MUTED, { bold: true, align: 'right' }); d.text('ENDED WITH', 400, d.y, 7.5, MUTED, { bold: true, align: 'right' }); d.text('WON / LOST', 555, d.y, 7.5, MUTED, { bold: true, align: 'right' }); d.y -= 14;
    me.sessions.forEach((r) => {
      d.need(16);
      d.text(`Session ${r.no}  ${timeOnly(r.from, tz)}${r.to ? ' - ' + timeOnly(r.to, tz) : ''}`, 40, d.y, 9.5, INK);
      d.text(fmt(r.start), 240, d.y, 9.5, INK, { align: 'right' }); d.text(fmt(r.end), 400, d.y, 9.5, INK, { align: 'right' });
      d.text(signed(r.net), 555, d.y, 9.5, r.net > 0 ? GREEN : r.net < 0 ? RED : INK, { align: 'right', bold: true });
      d.y -= 15;
    });
    d.y -= 12;
  }

  // chart
  d.need(210);
  section('CHIP STACK AFTER EACH HAND');
  const hist = me.history.filter((h) => h.stack != null);
  const cx = 40, cw = 515, ch = 130, cy = d.y - ch;
  d.rect(cx, cy, cw, ch, PALE);
  if (hist.length >= 2) {
    const vals = hist.map((h) => h.stack);
    let lo = Math.min(...vals), hi = Math.max(...vals); if (hi === lo) { hi += 1; lo -= 1; }
    const px = (i) => cx + 12 + (cw - 24) * i / (vals.length - 1), py = (v) => cy + 14 + (ch - 36) * (v - lo) / (hi - lo);
    d.line(cx + 12, py(vals[0]), cx + cw - 12, py(vals[0]), LINE, 0.5, true);
    hist.forEach((h, i) => { if (h.kind === 'deck') { d.line(px(i), cy + 8, px(i), cy + ch - 18, GOLDL, 0.8, true); d.text('DC' + h.session, px(i) + 3, cy + ch - 16, 7, GOLD, { bold: true }); } });
    let path = vals.map((v, i) => `${px(i).toFixed(1)} ${py(v).toFixed(1)} ${i ? 'l' : 'm'}`).join(' ');
    d.op(`${hex(INK)} RG 1.4 w [] 0 d ${path} S`);
    d.text('Low ' + fmt(lo), cx + 12, cy + 3, 8, MUTED); d.text('High ' + fmt(hi), cx + cw - 12, cy + 3, 8, MUTED, { align: 'right' });
    d.text('Start ' + timeOnly(hist[0].t, tz), cx + cw / 2 - 60, cy + 3, 8, MUTED, { align: 'center' });
    d.text('End ' + timeOnly(hist[hist.length - 1].t, tz), cx + cw / 2 + 60, cy + 3, 8, MUTED, { align: 'center' });
  } else d.text('Not enough hands played to draw a graph.', cx + cw / 2, cy + ch / 2, 10, MUTED, { align: 'center' });
  d.y = cy - 26;

  // deck changes
  const decks = hist.filter((h) => h.kind === 'deck');
  if (decks.length) {
    section('CHIP COUNT AT EACH DECK CHANGE');
    decks.forEach((h) => { d.need(16); d.text(`Deck change ${h.session}`, 40, d.y, 9.5, INK); d.text(timeOnly(h.t, tz), 300, d.y, 9.5, MUTED, { align: 'right' }); d.text(fmt(h.stack), 555, d.y, 9.5, INK, { align: 'right', bold: true }); d.y -= 14; });
    d.y -= 12;
  }

  // buy-in timings
  section('BUY-INS AND CHIP MOVEMENTS');
  d.text('DATE AND TIME', 40, d.y, 7.5, MUTED, { bold: true }); d.text('ENTRY', 190, d.y, 7.5, MUTED, { bold: true }); d.text('CHIPS', 555, d.y, 7.5, MUTED, { bold: true, align: 'right' }); d.y -= 14;
  me.ledger.forEach((l) => {
    d.need(18);
    const label = l.kind === 'buyin' ? (l.by === 'carried over' ? 'Chips carried over from the last game' : 'Buy-in') : l.kind === 'cashout' ? 'Cashed out' : 'Banker adjustment' + (l.reason ? ' - ' + l.reason : '');
    d.text(stamp(l.t, tz), 40, d.y, 9.5, INK); d.text(label, 190, d.y, 9.5, INK);
    d.text(signed(l.amount), 555, d.y, 9.5, l.amount < 0 ? RED : INK, { align: 'right' });
    d.line(40, d.y - 5, 555, d.y - 5, LINE, 0.3); d.y -= 16;
  });
  d.need(30);
  d.line(40, d.y + 6, 555, d.y + 6, INK, 0.8); d.y -= 8;
  d.text(me.carried >= me.invested && me.invested > 0 ? 'Total put in (carried over)' : 'Total bought in', 190, d.y, 9.5, INK, { bold: true }); d.text(fmt(me.invested), 555, d.y, 9.5, INK, { align: 'right', bold: true }); d.y -= 16;
  d.text(final.live ? 'Chips now' : 'Final chip count', 190, d.y, 9.5, INK, { bold: true }); d.text(fmt(me.final), 555, d.y, 9.5, INK, { align: 'right', bold: true }); d.y -= 20;
  d.need(30);
  d.text('Chips are virtual. Settle the amounts above between yourselves in whatever way you have agreed.', 40, d.y, 8, MUTED);
  return d.build();
}

module.exports = { settle, buildFinal, statementPdf, sessionRows };
