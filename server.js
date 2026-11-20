'use strict';
// Smart Buddies server. No dependencies: plain Node http + server-sent events.
// Game state lives in memory. Private cards are only ever sent to their owner.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Hand, newDeck, shuffle, VARIANTS } = require('./engine');
const RUNIT_SECONDS = Number(process.env.RUNIT_SECONDS || 15);
const { createClub } = require('./club');
const { buildFinal, statementPdf, sessionRows } = require('./statement');

const PORT = process.env.PORT || 3000;
const NEXT_HAND_DELAY_MS = Number(process.env.NEXT_HAND_DELAY_MS || 7000);
const DRAW_SHOW_MS = Number(process.env.DRAW_SHOW_MS || 9000);
const NOTICE_MS = 60 * 60 * 1000; // call time: at least one hour before standing up
const SUIT_RANK = 'cdhs';       // clubs < diamonds < hearts < spades for breaking ties in the seat draw
const RANK_RANK = '23456789TJQKA';
const tables = new Map();
const statementLinks = new Map(); // unguessable download token -> who it belongs to
const publicBase = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

const rid = (n = 16) => crypto.randomBytes(n).toString('hex');
const clampInt = (v, lo, hi, d) => {
  v = Math.floor(Number(v));
  if (!Number.isFinite(v)) return d;
  return Math.min(hi, Math.max(lo, v));
};

function newCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)]; } while (tables.has(c));
  return c;
}

function cleanSettings(s = {}, old = {}) {
  const sb = clampInt(s.sb, 1, 1e7, old.sb || 25);
  const bb = clampInt(s.bb, sb, 1e7, old.bb || sb * 2);
  return {
    sb, bb,
    turnSeconds: clampInt(s.turnSeconds, 10, 180, old.turnSeconds || 40),
    minBuyin: clampInt(s.minBuyin, 1, 1e9, old.minBuyin || bb),
    maxBuyin: Math.max(clampInt(s.maxBuyin, bb, 1e9, old.maxBuyin || bb * 200), clampInt(s.minBuyin, 1, 1e9, old.minBuyin || bb)),
    bombAnteBB: clampInt(s.bombAnteBB, 1, 100, old.bombAnteBB || 5),   // bomb pot ante, in big blinds
    bombMax: clampInt(s.bombMax, 2, 10, old.bombMax || 10),            // most players in the 2-card bomb pot
    runItMin: clampInt(s.runItMin, 0, 1e9, old.runItMin || 0),         // pots at least this big can be run more than once (0 = off)
    maxSeats: 10,
    sessionMinutes: clampInt(s.sessionMinutes, 1, 600, old.sessionMinutes || 120),
  };
}

function makeTable(adminName, settings) {
  const t = {
    code: newCode(), createdAt: Date.now(), settings: cleanSettings(settings),
    players: new Map(), order: new Array(10).fill(null), adminId: null,
    hand: null, handNo: 0, running: false, buttonSeat: -1,
    pending: [], notes: [], log: [], clients: new Map(), timer: null, nextTimer: null,
    deadline: 0, lastResult: null, closed: false, forceVariant: null, variant: 'none', vmark: null, special: false,
    sessionNo: 0, sessionEndsAt: 0, sessionEnding: false, draw: null, drawUntil: 0,
    ended: false, ending: false, joins: [], departed: [], sessLog: [],
  };
  tables.set(t.code, t);
  const admin = addPlayer(t, adminName);
  t.adminId = admin.id;
  return { t, admin };
}

function addPlayer(t, name) {
  const seat = t.order.indexOf(null);
  if (seat < 0) throw httpErr(400, 'The table is full');
  const p = {
    id: rid(6), token: rid(24), name, seat, stack: 0, queued: 0, bought: 0,
    connected: false, history: [], ledger: [], leaving: false, away: false, misses: 0,
    approved: true, stayUntil: 2, callAfter: 0, ghost: false, ghostUntil: 0, optIn: false,
  };
  t.players.set(p.id, p);
  t.order[seat] = p.id;
  // once the game is under way, newcomers wait for the admin to let them in
  if (t.sessionNo > 0 && t.adminId) {
    p.approved = false;
    t.joins.push({ id: rid(4), playerId: p.id, name: p.name, at: Date.now() });
    say(t, `${p.name} would like to join. Waiting for the admin.`);
  }
  return p;
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
function say(t, text) { t.log.push({ at: Date.now(), text }); if (t.log.length > 40) t.log.shift(); }
const nameOf = (t, id) => (t.players.get(id) || { name: '?' }).name;

// the latest chip changes a banker can undo (not their own, unless they are the admin)
function recentChanges(t, pid, isAdmin) {
  const out = [];
  for (const p of t.players.values()) {
    if (p.id === pid && !isAdmin) continue;
    p.ledger.forEach((e, i) => {
      if (!['buyin', 'adjust'].includes(e.kind) || !e.amount) return;
      out.push({ playerId: p.id, name: p.name, index: i, kind: e.kind, amount: e.amount, reason: e.reason || '', at: e.t, done: !!(e.reversed || e.undo), undo: !!e.undo });
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 12);
}

// the special game: what the admin chose and how many hands until it is played
function specialInfo(t) {
  const ring = lineup(t);
  let nextIn = 0;
  if (t.variant !== 'none' && t.vmark && ring.length > 1) {
    const mi = ring.findIndex((p) => p.id === t.vmark);
    const bi = ring.findIndex((p) => p.seat >= t.buttonSeat);
    if (mi >= 0) {
      const target = (mi - 1 + ring.length) % ring.length, cur = bi < 0 ? ring.length - 1 : (ring[bi].seat === t.buttonSeat ? bi : (bi - 1 + ring.length) % ring.length);
      nextIn = (target - cur + ring.length) % ring.length || ring.length;
    }
  }
  const V = VARIANTS[t.variant];
  return { force: t.forceVariant, forceName: t.forceVariant ? VARIANTS[t.forceVariant].name : '', choice: t.variant, name: V ? V.name : '', max: V ? (t.variant === 'bomb2' ? Math.min(V.max, t.settings.bombMax) : V.max) : 0, nextIn, now: !!t.special, optedIn: [...t.players.values()].filter((p) => p.optIn && !p.ghost && p.approved).length,
    games: Object.entries(VARIANTS).filter(([k]) => k !== 'holdem').map(([k, v]) => ({ kind: k, name: v.name, max: k === 'bomb2' ? Math.min(v.max, t.settings.bombMax) : v.max })) };
}

// ---------- views ----------
function viewFor(t, pid) {
  const me = t.players.get(pid);
  const hv = t.hand ? t.hand.view(pid) : null;
  const seats = [];
  for (let s = 0; s < t.settings.maxSeats; s++) {
    const id = t.order[s];
    if (!id) { seats.push(null); continue; }
    const p = t.players.get(id);
    const hp = hv && hv.players.find((x) => x.id === id);
    seats.push({
      seat: s, id, name: p.name, optIn: !!p.optIn, isAdmin: id === t.adminId, connected: p.connected, away: p.away, ghost: p.ghost, approved: p.approved, roles: (p.roles || []).filter((r) => ROLE_NAMES.includes(r)),
      stack: hp ? hp.stack : p.stack, inHand: !!hp, bet: hp ? hp.bet : 0,
      folded: hp ? hp.folded : false, allIn: hp ? hp.allIn : false,
      cards: hp ? hp.cards : null, isButton: !!(hp && hp.isButton),
      isTurn: !!(hv && hv.turnId === id), net: p.stack + (hp ? 0 : 0) - p.bought,
    });
  }
  const isAdmin = pid === t.adminId;
  return {
    now: Date.now(), code: t.code, settings: t.settings, running: t.running, handNo: t.handNo,
    you: {
      id: pid, name: me.name, isAdmin, seat: me.seat, stack: seats[me.seat].stack,
      optIn: !!me.optIn, queued: me.queued, bought: me.bought, inHand: seats[me.seat].inHand, away: me.away,
      can: Object.fromEntries(ROLE_NAMES.map((r) => [r, can(t, me, r)])), member: !!me.memberId,
      approved: me.approved, ghost: me.ghost, ghostUntil: me.ghostUntil, ghostEndsAt: me.ghost ? sessionEnd(t, me.ghostUntil) : 0, stayUntil: me.stayUntil, callAfter: me.callAfter,
      leave: leaveInfo(t, me), callOptions: callOptions(t, me),
    },
    session: {
      no: t.sessionNo, endsAt: t.sessionEndsAt, ending: t.sessionEnding, minutes: t.settings.sessionMinutes,
      ended: t.ended, endingGame: t.ending, draw: Date.now() < t.drawUntil + 4000 ? t.draw : null,
    },
    joins: can(t, me, 'players') ? t.joins : [],
    settlement: t.final && {
      at: t.final.at, transfers: isAdmin ? t.final.transfers : t.final.transfers.filter((x) => x.from === pid || x.to === pid),
      people: t.final.people.filter((x) => isAdmin || x.id === pid).map((x) => {
        const o = { id: x.id, name: x.name, invested: x.invested, final: x.final, net: x.net };
        if (x.id === pid || isAdmin) { o.link = '/s/' + x.dl + '.pdf'; }
        if (isAdmin && x.memberId) { const m = club.state().members[x.memberId]; if (m) o.phone = m.phone || ''; }
        return o;
      }),
    },
    seats,
    corrections: can(t, me, 'bank') ? recentChanges(t, pid, isAdmin) : [],
    special: specialInfo(t),
    hand: hv && { variant: hv.variant, variantName: hv.variantName, hole: hv.hole, boards: hv.boards, boardKind: hv.boardKind, runit: hv.runit, runs: hv.runs, street: hv.street, board: hv.board, pot: hv.pot, currentBet: hv.currentBet, turnId: hv.turnId, finished: hv.finished, legal: hv.legal, deadline: t.deadline },
    result: t.lastResult,
    log: t.log.slice(-12),
    pending: can(t, me, 'bank') ? t.pending : t.pending.filter((r) => r.playerId === pid),
    notes: can(t, me, 'bank') ? (t.notes || []) : [],
    ledger: me.ledger.slice(-30),
    history: me.history, sessions: sessionRows(t.sessLog, me.history, me.ledger, me.stack + me.queued),
  };
}

function send(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function broadcast(t) {
  markTables();
  for (const [pid, set] of t.clients) {
    if (!t.players.has(pid)) continue;
    const v = viewFor(t, pid);
    for (const res of set) { try { send(res, v); } catch (e) { /* closed */ } }
  }
}

// ---------- game flow ----------
// ---------- sessions, seat draw and deck changes ----------
const sessionLen = (t) => t.settings.sessionMinutes * 60000;
const sessionEnd = (t, k) => t.sessionEndsAt + (k - t.sessionNo) * sessionLen(t);
const cardStrength = (c) => RANK_RANK.indexOf(c[0]) * 4 + SUIT_RANK.indexOf(c[1]);

// Dealt in: has chips, is in, not sitting out. Ghosts (left early) only pay blinds.
function dealtIn(t) {
  return [...t.players.values()].filter((p) => p.approved && !p.away && !p.ghost && !p.leaving && p.stack > 0)
    .sort((a, b) => a.seat - b.seat);
}
function lineup(t) {
  return [...t.players.values()].filter((p) => p.approved && !p.leaving && p.stack > 0 && (p.ghost || (!p.away)))
    .sort((a, b) => a.seat - b.seat);
}

// One card each from a fresh deck: highest takes the button and the seats follow in order
function startSession(t) {
  t.sessionNo++;
  if (t.sessionNo > 1) for (const p of t.players.values()) p.optIn = false; // opting in for the special games is once per session (choices made before the game starts count for session 1)
  t.sessionEnding = false;
  t.sessLog.push({ no: t.sessionNo, start: Date.now(), end: 0 });
  const all = [...t.players.values()];
  const part = all.filter((p) => p.approved);
  const deck = shuffle(newDeck());
  const draws = part.map((p) => ({ p, card: deck.pop() })).sort((x, y) => cardStrength(y.card) - cardStrength(x.card));
  const waiting = all.filter((p) => !p.approved).sort((x, y) => x.seat - y.seat);
  t.order.fill(null);
  [...draws.map((d) => d.p), ...waiting].forEach((p, i) => { p.seat = i; t.order[i] = p.id; });
  t.buttonSeat = t.order.length - 1; // the first seat after this one (seat 0) takes the button
  t.draw = {
    session: t.sessionNo, buttonId: draws[0].p.id,
    cards: draws.map((d) => ({ id: d.p.id, name: d.p.name, card: d.card, ghost: d.p.ghost })),
  };
  t.drawUntil = Date.now() + DRAW_SHOW_MS;
  t.sessionEndsAt = t.drawUntil + sessionLen(t);
  say(t, `Session ${t.sessionNo}: seat draw. ${draws[0].p.name} drew the high card and has the button`);
}

function cashOut(t, p, text) {
  const amount = p.stack + p.queued;
  p.ledger.push({ t: Date.now(), kind: 'cashout', amount: -amount, by: 'table' });
  p.history.push({ t: Date.now(), stack: 0, kind: 'cashout' });
  t.departed.push({ id: p.id, memberId: p.memberId, token: p.token, name: p.name, left: Date.now(), amount, history: p.history, ledger: p.ledger });
  say(t, `${text} (${amount} chips)`);
  removePlayer(t, p, `${text}. You leave with ${amount} chips.`);
}

function deckChange(t) {
  const k = t.sessionNo;
  for (const p of t.players.values()) p.history.push({ t: Date.now(), stack: p.stack + p.queued, kind: 'deck', session: k });
  if (t.sessLog[k - 1]) t.sessLog[k - 1].end = Date.now();
  say(t, `Session ${k} is over. Deck change.`);
  for (const p of [...t.players.values()]) {
    if (p.id === t.adminId) continue;
    if (p.ghost && p.ghostUntil <= k) cashOut(t, p, `${p.name} is released after session ${k}`);
    else if (!p.ghost && p.callAfter && p.callAfter <= k) cashOut(t, p, `${p.name} stood up after session ${k}`);
  }
  t.sessionEnding = false;
  if (t.ending) return finalize(t);
  startSession(t);
}

function finalize(t) {
  t.running = false; t.ended = true; t.ending = false; t.sessionEnding = false;
  clearTimeout(t.timer); clearTimeout(t.nextTimer); t.deadline = 0;
  for (const p of [...t.players.values()]) {
    p.roles = []; // delegated powers end with the game
    p.history.push({ t: Date.now(), stack: p.stack + p.queued, kind: 'end' });
    if (p.ghost) cashOut(t, p, `${p.name} is released, the game is over`);
  }
  { const last = t.sessLog[t.sessLog.length - 1]; if (last && !last.end) last.end = Date.now(); }
  t.final = buildFinal(t);
  say(t, 'The game is over. Thanks for playing.');
  for (const x of t.final.people) statementLinks.set(x.dl, { code: t.code, pid: x.id });
  club.gameEnded(t);
  club.sendStatements(t, (x) => publicBase() + '/s/' + x.dl + '.pdf');
  broadcast(t);
}

function resetGame(t) {
  t.ended = false; t.ending = false; t.sessionNo = 0; t.sessionEnding = false; t.draw = null; t.drawUntil = 0;
  t.final = null; t.departed = []; t.sessLog = []; t.vmark = null; t.special = false;
  for (const p of t.players.values()) p.optIn = false;
  for (const p of t.players.values()) { // a new game starts from the chips people hold now
    p.stayUntil = 2; p.callAfter = 0;
    const chips = p.stack + p.queued;
    p.bought = chips; p.history = [{ t: Date.now(), stack: chips, kind: 'start' }];
    p.ledger = chips ? [{ t: Date.now(), kind: 'buyin', amount: chips, by: 'carried over' }] : [];
  }
}

// what happens if this player stands up now
function leaveInfo(t, p) {
  if (p.id === t.adminId || p.ghost) return { free: false, none: true };
  if (t.sessionNo === 0 || !p.approved || t.ended) return { free: true };
  let until;
  if (t.sessionNo <= p.stayUntil) until = p.stayUntil; // early leaver: only the two-session minimum
  else {
    until = t.sessionNo; // no call time posted: one hour of notice, rounded up to a deck change
    while (sessionEnd(t, until) < Date.now() + NOTICE_MS) until++;
    if (p.callAfter) until = Math.max(p.stayUntil, Math.min(until, p.callAfter));
  }
  return { free: false, until, endsAt: sessionEnd(t, until) };
}
function callOptions(t, p) {
  if (t.sessionNo === 0 || p.id === t.adminId || p.ghost || t.ended) return [];
  const out = [];
  for (let n = Math.max(t.sessionNo, p.stayUntil), i = 0; i < 4; n++, i++) {
    const endsAt = sessionEnd(t, n);
    out.push({ session: n, endsAt, ok: endsAt - Date.now() >= NOTICE_MS });
  }
  return out;
}

function maybeStartHand(t) {
  if (t.closed || !t.running || t.ended || (t.hand && !t.hand.finished)) return;
  if (t.sessionNo > 0 && t.sessionEnding) { deckChange(t); if (t.ended) return; }
  if (t.sessionNo === 0) { if (dealtIn(t).length < 2) return; startSession(t); }
  const wait = t.drawUntil - Date.now();
  if (wait > 0) { clearTimeout(t.nextTimer); t.nextTimer = setTimeout(() => maybeStartHand(t), wait + 50); broadcast(t); return; }
  const live = dealtIn(t);
  if (live.length < 2) { broadcast(t); return; }
  const ring = lineup(t); // ghosts keep their place in the ring and pay their blinds
  // next button: first seat after the previous button
  let btn = ring[0];
  for (let k = 1; k <= 10; k++) {
    const s = (t.buttonSeat + k) % 10;
    const cand = ring.find((p) => p.seat === s);
    if (cand) { btn = cand; break; }
  }
  t.buttonSeat = btn.seat;
  // The special game (the variant the admin chose) is played once in every round of Hold'em. A marker sits with one player;
  // it is played on the hand where the button is with the player just before the marker, and after it the marker moves
  // one player back, so the special hand comes one hand earlier in the next round.
  const at = (id) => ring.findIndex((p) => p.id === id);
  if (at(t.vmark) < 0) t.vmark = btn.id;
  const before = ring[(at(t.vmark) - 1 + ring.length) % ring.length];
  let kind = 'holdem', players, buttonIdx, note = '';
  // the admin can also switch the next hand to any game on request; that replaces the scheduled special game for this hand
  let want = 'none';
  if (t.forceVariant) { want = t.forceVariant; t.forceVariant = null; if (btn.id === before.id) t.vmark = btn.id; }
  else if (btn.id === before.id) { t.vmark = btn.id; want = t.variant; }
  {
    if (want !== 'none' && VARIANTS[want]) {
      const V = VARIANTS[want], max = want === 'bomb2' ? Math.min(V.max, t.settings.bombMax) : V.max;
      // only players who opted in are dealt in, and never ghosts. Starting from the button, the seats just before it are dealt out first if too many opted in.
      const start = ring.findIndex((p) => p.seat >= btn.seat); // the first opted-in player at or after the dealer seat
      const order = ring.slice(start < 0 ? 0 : start).concat(ring.slice(0, start < 0 ? 0 : start)).filter((p) => p.optIn && !p.ghost);
      const out = order.length > max ? order.splice(max) : [];
      if (order.length >= 2) {
        kind = want;
        const seated = order.slice().sort((a, b) => a.seat - b.seat);
        players = seated.map((p) => ({ id: p.id, seat: p.seat, stack: p.stack }));
        buttonIdx = players.findIndex((p) => p.id === order[0].id);
        note = out.length ? ` (${out.map((p) => p.name).join(', ')} dealt out, only ${max} can play)` : '';
      } else say(t, `${V.name} skipped: fewer than two players opted in`);
    }
  }
  if (kind === 'holdem') {
    players = ring.map((p) => ({ id: p.id, seat: p.seat, stack: p.stack, ghost: p.ghost }));
    buttonIdx = players.findIndex((p) => p.id === btn.id);
  }
  t.handNo++;
  t.lastResult = null;
  t.special = kind !== 'holdem';
  t.hand = new Hand({ players, buttonIdx, sb: t.settings.sb, bb: t.settings.bb, variant: kind, bombAnte: t.settings.bombAnteBB * t.settings.bb, runItMin: t.settings.runItMin });
  say(t, kind === 'holdem' ? `Hand ${t.handNo}: ${btn.name} has the button` : `Hand ${t.handNo}: ${VARIANTS[kind].name}. ${t.hand.players[buttonIdx].id === btn.id ? btn.name : t.players.get(t.hand.players[buttonIdx].id).name} has the button${note}`);
  afterHandChange(t);
}

const DISCONNECT_TURN_SECONDS = Number(process.env.DISCONNECT_TURN_SECONDS || 10);
const MISSES_BEFORE_AWAY = 2;

// (re)start the turn clock for whoever is to act
function armTimer(t, secs) {
  clearTimeout(t.timer);
  t.deadline = Date.now() + secs * 1000;
  t.timer = setTimeout(() => {
    if (!t.hand || t.hand.finished) return;
    const a = t.hand.autoAction();
    try {
      t.hand.act(a.id, a.type);
      say(t, `${nameOf(t, a.id)} ran out of time and ${a.type === 'check' ? 'checks' : 'folds'}`);
      const p = t.players.get(a.id);
      if (p) {
        p.misses++;
        if (p.misses >= MISSES_BEFORE_AWAY && !p.away) { p.away = true; say(t, `${p.name} is sitting out`); }
      }
      afterHandChange(t);
    } catch (e) { /* ignore */ }
  }, secs * 1000 + 300);
}

function afterHandChange(t) {
  clearTimeout(t.timer);
  const h = t.hand;
  if (h && h.finished) return finishHand(t);
  if (h && h.runit) {
    t.deadline = Date.now() + RUNIT_SECONDS * 1000;
    t.timer = setTimeout(() => { if (t.hand === h && h.runit) { h.resolveRunIt(); afterHandChange(t); } }, RUNIT_SECONDS * 1000 + 300);
    return broadcast(t);
  }
  if (h && h.turnId) {
    const tp = t.players.get(h.turnId);
    const secs = tp && !tp.connected ? Math.min(t.settings.turnSeconds, DISCONNECT_TURN_SECONDS) : t.settings.turnSeconds;
    armTimer(t, secs);
    // members who have switched on phone notifications are told it is their turn (the app stays quiet if it is open in front)
    if (tp && tp.memberId && Date.now() - (tp.lastTurnPush || 0) > 15000) {
      tp.lastTurnPush = Date.now();
      const m = club.state().members[tp.memberId];
      if (m) club.pushMember(m, { title: 'Your turn', body: `Room ${t.code}: it is your turn to act.`, tag: 'turn-' + t.code, url: '/' });
    }
  }
  broadcast(t);
}

function finishHand(t) {
  const h = t.hand;
  for (const hp of h.players) {
    const p = t.players.get(hp.id);
    p.stack = hp.stack + p.queued;
    if (p.queued) { p.queued = 0; }
    p.history.push({ t: Date.now(), stack: p.stack, kind: 'hand', hand: t.handNo });
  }
  const r = h.result;
  const names = (id) => nameOf(t, id);
  t.lastResult = {
    handNo: t.handNo, uncontested: r.uncontested, board: h.board.slice(), variant: h.variant, variantName: h.v.name,
    boards: h.boards.map((b) => b.slice()), boardKind: h.boardKind, runs: h.runs,
    boardResults: (r.boardResults || []).map((br) => ({
      board: br.board,
      hands: Object.fromEntries(Object.entries(br.hands).map(([id, x]) => [id, { handName: x.handName, best: x.best }])),
      winners: Object.entries(br.winners).map(([id, amount]) => ({ id, name: names(id), amount })),
    })),
    reveal: Object.fromEntries(Object.entries(r.reveal).map(([id, v]) => [id, { name: names(id), ...v }])),
    won: Object.entries(r.won).map(([id, amount]) => ({
      id, name: names(id), amount,
      handName: r.reveal[id] ? r.reveal[id].handName : null,
    })),
    pots: r.pots.length,
  };
  for (const w of t.lastResult.won) say(t, `${w.name} wins ${w.amount}${w.handName ? ' with ' + w.handName.toLowerCase() : ''}`);
  // players who stood up during the hand, and early leavers who have paid everything they had
  for (const p of [...t.players.values()]) {
    if (p.leaving) removePlayer(t, p, 'You have left the table.');
    else if (p.ghost && p.stack <= 0) { say(t, `${p.name} has no chips left to pay blinds and is released`); removePlayer(t, p, 'You are released, your chips are gone.'); }
  }
  t.deadline = 0;
  if (t.ending) return finalize(t);
  broadcast(t);
  clearTimeout(t.nextTimer);
  t.nextTimer = setTimeout(() => maybeStartHand(t), r.uncontested ? NEXT_HAND_DELAY_MS : Math.max(NEXT_HAND_DELAY_MS, Math.min(NEXT_HAND_DELAY_MS * 2, 14000)));
}

function removePlayer(t, p, reason) {
  t.joins = t.joins.filter((r) => r.playerId !== p.id);
  const set = t.clients.get(p.id);
  if (set) for (const res of set) { try { send(res, { gone: true, text: reason || 'You have left the table.', stack: p.stack + p.queued }); res.end(); } catch (e) { /* closed */ } }
  t.order[p.seat] = null;
  t.players.delete(p.id);
  t.clients.delete(p.id);
}

// remove a player now, or when the running hand ends if they are in it
function takeOut(t, p, text) {
  const inHand = t.hand && !t.hand.finished && t.hand.players.some((x) => x.id === p.id);
  say(t, text);
  p.leaving = true;
  if (inHand) {
    if (t.hand.turnId === p.id) { t.hand.act(p.id, 'fold'); afterHandChange(t); }
    else { const hp = t.hand.players.find((x) => x.id === p.id); if (!hp.folded) { hp.folded = true; t.hand.afterAction(); afterHandChange(t); } }
  } else { removePlayer(t, p, text); broadcast(t); }
}

function credit(t, p, amount, kind, by) {
  const inHand = t.hand && !t.hand.finished && t.hand.players.some((x) => x.id === p.id);
  if (inHand) p.queued += amount; else p.stack += amount;
  if (kind === 'buyin') p.bought += amount;
  p.ledger.push({ t: Date.now(), kind, amount, by });
  p.history.push({ t: Date.now(), stack: p.stack + p.queued, kind });
}

// ---------- API ----------
const body = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 20000) { reject(httpErr(413, 'Too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(httpErr(400, 'Bad JSON')); } });
});

function cleanName(n) {
  n = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
  if (!n) throw httpErr(400, 'Enter a nickname');
  return n;
}

function getTable(code) {
  const t = tables.get(String(code || '').toUpperCase().trim());
  if (!t) throw httpErr(404, 'No table with that code');
  return t;
}
function auth(b) {
  const t = getTable(b.code);
  for (const p of t.players.values()) if (p.token === b.token) return { t, p };
  throw httpErr(401, 'You are not at this table');
}
// Powers: the admin has all of them; delegated members hold some (start, bank, settings, players).
const ROLE_NAMES = ['start', 'bank', 'settings', 'players'];
const can = (t, p, role) => p.id === t.adminId || (Array.isArray(p.roles) && p.roles.includes(role));
function need(t, p, role) { if (!can(t, p, role)) throw httpErr(403, 'You do not have permission to do that'); }

const routes = {
  create(b) {
    const name = cleanName(b.name);
    const { t, admin } = makeTable(name, b.settings);
    say(t, `${name} opened the table`);
    return { code: t.code, token: admin.token, pid: admin.id };
  },
  join(b) {
    const t = getTable(b.code);
    if (t.membersOnly) throw httpErr(403, 'This table is for invited members. Open your personal invite link.');
    const name = cleanName(b.name);
    if ([...t.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase()))
      throw httpErr(400, 'That nickname is taken at this table');
    const p = addPlayer(t, name);
    say(t, `${name} sat down`);
    broadcast(t);
    return { code: t.code, token: p.token, pid: p.id };
  },
  buyin(b) {
    const { t, p } = auth(b);
    if (!p.approved) throw httpErr(400, 'The admin has to let you in first');
    if (p.ghost) throw httpErr(400, 'You have left the table');
    const amount = clampInt(b.amount, 1, t.settings.maxBuyin, 0);
    if (!amount) throw httpErr(400, `Enter an amount up to ${t.settings.maxBuyin}`);
    if (amount < t.settings.minBuyin && p.stack + p.queued + amount < t.settings.minBuyin)
      throw httpErr(400, `The minimum buy-in is ${t.settings.minBuyin}`);
    if (p.id === t.adminId) {
      credit(t, p, amount, 'buyin', 'banker');
      say(t, `${p.name} bought in for ${amount}`);
      broadcast(t); maybeStartHand(t);
      return { ok: true };
    }
    if (t.pending.some((r) => r.playerId === p.id)) throw httpErr(400, 'You already have a request waiting');
    t.pending.push({ id: rid(4), playerId: p.id, name: p.name, amount, at: Date.now() });
    broadcast(t);
    return { ok: true };
  },
  note(b) { // a player sends a short request to the admin
    const { t, p } = auth(b);
    const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!text) throw httpErr(400, 'Write a short message first');
    if (p.id === t.adminId) throw httpErr(400, 'You are the admin');
    t.notes = t.notes || [];
    if (Date.now() - (p.lastNote || 0) < 5000) throw httpErr(429, 'Wait a few seconds before sending another');
    p.lastNote = Date.now();
    t.notes = t.notes.filter((n) => n.playerId !== p.id || n.text !== text);
    t.notes.push({ id: rid(4), playerId: p.id, name: p.name, text, at: Date.now() });
    if (t.notes.length > 30) t.notes.shift();
    broadcast(t);
    return { ok: true };
  },
  notedone(b) {
    const { t, p } = auth(b); need(t, p, 'bank');
    t.notes = (t.notes || []).filter((n) => n.id !== b.noteId);
    broadcast(t);
    return { ok: true };
  },
  approve(b) {
    const { t, p } = auth(b); need(t, p, 'bank');
    const i = t.pending.findIndex((r) => r.id === b.reqId);
    if (i < 0) throw httpErr(404, 'Request not found');
    if (t.pending[i].playerId === p.id && p.id !== t.adminId) throw httpErr(403, 'Another banker must approve your own chips');
    const [r] = t.pending.splice(i, 1);
    const target = t.players.get(r.playerId);
    if (b.ok && target) {
      credit(t, target, r.amount, 'buyin', 'banker');
      say(t, `${target.name} bought in for ${r.amount}`);
    }
    broadcast(t); maybeStartHand(t);
    return { ok: true };
  },
  adjust(b) {
    const { t, p } = auth(b); need(t, p, 'bank');
    const target = t.players.get(b.playerId);
    if (!target) throw httpErr(404, 'Player not found');
    if (target.id === p.id && p.id !== t.adminId) throw httpErr(403, 'You cannot adjust your own chips');
    const delta = clampInt(b.delta, -1e9, 1e9, 0);
    if (!delta) throw httpErr(400, 'Enter an amount');
    if (delta < 0 && target.stack + target.queued + delta < 0) throw httpErr(400, 'That is more than they hold');
    credit(t, target, delta, 'adjust', 'banker');
    target.ledger[target.ledger.length - 1].reason = String(b.reason || '').slice(0, 60);
    say(t, `Banker adjusted ${target.name} by ${delta > 0 ? '+' : ''}${delta}`);
    broadcast(t); maybeStartHand(t);
    return { ok: true };
  },
  // correct a mistake: reverse a buy-in or an adjustment. The original stays on the statement and a correcting entry is added.
  undo(b) {
    const { t, p } = auth(b); need(t, p, 'bank');
    const target = t.players.get(b.playerId);
    if (!target) throw httpErr(404, 'Player not found');
    if (target.id === p.id && p.id !== t.adminId) throw httpErr(403, 'Another banker must correct your own chips');
    const e = target.ledger[Math.floor(Number(b.index))];
    if (!e || !['buyin', 'adjust'].includes(e.kind) || e.undo || e.reversed || !e.amount) throw httpErr(400, 'That entry cannot be undone');
    const delta = -e.amount;
    if (target.stack + target.queued + delta < 0) throw httpErr(400, `${target.name} no longer has those chips. Adjust by hand instead.`);
    const label = e.kind === 'buyin' ? 'buy-in' : (e.reason || 'adjustment');
    credit(t, target, delta, 'adjust', 'banker');
    const c = target.ledger[target.ledger.length - 1];
    c.reason = ('Undo: ' + label).slice(0, 60); c.undo = true;
    e.reversed = true;
    if (e.kind === 'buyin') target.bought -= e.amount;
    say(t, `Banker undid ${target.name}'s ${label} (${e.amount > 0 ? '+' : ''}${e.amount})`);
    broadcast(t); maybeStartHand(t);
    return { ok: true };
  },
  settings(b) {
    const { t, p } = auth(b); need(t, p, 'settings');
    t.settings = cleanSettings(b.settings, t.settings);
    say(t, `Blinds are now ${t.settings.sb}/${t.settings.bb} from the next hand`);
    broadcast(t);
    return { ok: true };
  },
  start(b) {
    const { t, p } = auth(b); need(t, p, 'start');
    if (t.ended) resetGame(t);
    t.running = true;
    say(t, 'The admin started the game');
    broadcast(t); maybeStartHand(t);
    return { ok: true };
  },
  pause(b) {
    const { t, p } = auth(b); need(t, p, 'start');
    t.running = false;
    say(t, 'The admin paused after this hand');
    broadcast(t);
    return { ok: true };
  },
  act(b) {
    const { t, p } = auth(b);
    if (!t.hand || t.hand.finished) throw httpErr(400, 'No hand in progress');
    try { t.hand.act(p.id, String(b.type), b.amount); }
    catch (e) { throw httpErr(400, e.message); }
    p.misses = 0;
    afterHandChange(t);
    return { ok: true };
  },
  // vote on dealing the rest of the board once, twice or three times (big all-in pots only)
  runit(b) {
    const { t, p } = auth(b);
    if (!t.hand || t.hand.finished || !t.hand.runit) throw httpErr(400, 'There is no vote open');
    try { t.hand.vote(p.id, b.runs); } catch (e) { throw httpErr(400, e.message); }
    afterHandChange(t);
    return { ok: true };
  },
  // the special game: opt in or out for this session
  optin(b) {
    const { t, p } = auth(b);
    if (p.ghost || !p.approved) throw httpErr(400, 'You cannot opt in right now');
    p.optIn = !!b.on;
    say(t, `${p.name} ${p.optIn ? 'opted in to' : 'opted out of'} the special games`);
    broadcast(t);
    return { ok: true, optIn: p.optIn };
  },
  // the admin (or a delegate with the settings power) chooses the special game
  variant(b) {
    const { t, p } = auth(b); need(t, p, 'settings');
    const k = String(b.kind);
    if (k !== 'none' && (!VARIANTS[k] || k === 'holdem')) throw httpErr(400, 'Unknown game');
    t.variant = k;
    say(t, k === 'none' ? 'No special game' : `Special game: ${VARIANTS[k].name}`);
    broadcast(t);
    return { ok: true };
  },
  // the admin plays the next hand as any game, because the players asked for it
  playnow(b) {
    const { t, p } = auth(b); need(t, p, 'settings');
    const k = String(b.kind);
    if (k === 'holdem' || k === 'none') { t.forceVariant = null; say(t, "Next hand is Texas Hold'em as usual"); }
    else if (!VARIANTS[k]) throw httpErr(400, 'Unknown game');
    else { t.forceVariant = k; say(t, `Next hand: ${VARIANTS[k].name}, by request. Only players who opted in are dealt.`); }
    broadcast(t);
    return { ok: true };
  },
  leave(b) {
    const { t, p } = auth(b);
    if (p.id === t.adminId) throw httpErr(400, 'The admin cannot leave. Pause the game instead.');
    if (p.ghost) throw httpErr(400, 'You have already left. The admin can release you early in an emergency.');
    const info = leaveInfo(t, p);
    if (info.free) {
      takeOut(t, p, `${p.name} left the table with ${p.stack + p.queued}`);
      return { ok: true, left: true };
    }
    // standing up early: the seat stays in the ring and pays its blinds until the minimum is served
    p.ghost = true; p.ghostUntil = info.until; p.callAfter = 0; p.away = false;
    say(t, `${p.name} left early. Blinds continue until the end of session ${info.until}`);
    const inHand = t.hand && !t.hand.finished && t.hand.players.some((x) => x.id === p.id);
    if (inHand) {
      if (t.hand.turnId === p.id) { t.hand.act(p.id, 'fold'); afterHandChange(t); }
      else { const hp = t.hand.players.find((x) => x.id === p.id); if (!hp.folded) { hp.folded = true; t.hand.afterAction(); afterHandChange(t); } }
    }
    broadcast(t);
    return { ok: true, ghost: true, until: info.until };
  },
  calltime(b) {
    const { t, p } = auth(b);
    if (p.id === t.adminId) throw httpErr(400, 'The admin cannot stand up');
    if (p.ghost) throw httpErr(400, 'You have already left');
    if (t.sessionNo === 0) throw httpErr(400, 'Call time can be posted once the game has started');
    if (b.cancel) { p.callAfter = 0; say(t, `${p.name} cancelled the call time`); broadcast(t); return { ok: true }; }
    const n = Math.floor(Number(b.session));
    if (!(n >= Math.max(t.sessionNo, p.stayUntil))) throw httpErr(400, `You must stay until the end of session ${p.stayUntil} at least`);
    if (sessionEnd(t, n) - Date.now() < NOTICE_MS) throw httpErr(400, 'Call time must be posted at least one hour before you stand up');
    p.callAfter = n;
    say(t, `${p.name} posted call time: standing up after session ${n}`);
    broadcast(t);
    return { ok: true, session: n };
  },
  admit(b) {
    const { t, p } = auth(b); need(t, p, 'players');
    const i = t.joins.findIndex((r) => r.id === b.reqId);
    if (i < 0) throw httpErr(404, 'Request not found');
    const [r] = t.joins.splice(i, 1);
    const target = t.players.get(r.playerId);
    if (target) {
      if (b.ok) {
        target.approved = true; target.stayUntil = t.sessionNo + 2;
        if (target.memberId) autoBuyin(t, target);
        say(t, `${target.name} joins the table. Stays until the end of session ${target.stayUntil}`);
        broadcast(t); maybeStartHand(t);
      } else { say(t, `${target.name} was not let in`); removePlayer(t, target, 'The admin did not let you in this time.'); broadcast(t); }
    }
    return { ok: true };
  },
  // The admin lends powers to a player for this room only. They end with the game and can be taken back at any time.
  delegate(b) {
    const { t, p } = auth(b);
    if (p.id !== t.adminId) throw httpErr(403, 'Only the admin can hand out powers');
    const target = t.players.get(b.playerId);
    if (!target || target.id === t.adminId) throw httpErr(404, 'Player not found');
    if (t.ended) throw httpErr(400, 'The game has ended');
    const roles = [...new Set((Array.isArray(b.roles) ? b.roles : []).filter((r) => ROLE_NAMES.includes(r)))];
    const kept = (target.roles || []).filter((r) => !ROLE_NAMES.includes(r)); // e.g. event invitation power
    target.roles = roles.concat(kept);
    say(t, roles.length ? `${target.name} now has: ${roles.join(', ')}` : `${target.name}'s powers were taken back`);
    if (t.eventId && target.memberId) club.saveDelegates(t.eventId, target.memberId, target.roles);
    broadcast(t);
    return { roles };
  },
  endgame(b) {
    const { t, p } = auth(b); need(t, p, 'start');
    if (t.ended) throw httpErr(400, 'The game has already ended');
    if (t.hand && !t.hand.finished) { t.ending = true; say(t, 'The game will end after this hand'); broadcast(t); }
    else finalize(t);
    return { ok: true };
  },
  sitout(b) {
    const { t, p } = auth(b);
    p.away = true;
    say(t, `${p.name} is sitting out`);
    broadcast(t);
    return { ok: true };
  },
  back(b) {
    const { t, p } = auth(b);
    p.away = false; p.misses = 0;
    say(t, `${p.name} is back`);
    broadcast(t); maybeStartHand(t);
    return { ok: true };
  },
  setaway(b) {
    const { t, p } = auth(b); need(t, p, 'players');
    const target = t.players.get(b.playerId);
    if (!target) throw httpErr(404, 'Player not found');
    target.away = !!b.away;
    if (!target.away) target.misses = 0;
    say(t, target.away ? `Banker sat ${target.name} out` : `Banker brought ${target.name} back`);
    broadcast(t); maybeStartHand(t);
    return { ok: true };
  },
  kick(b) {
    const { t, p } = auth(b); need(t, p, 'players');
    const target = t.players.get(b.playerId);
    if (!target) throw httpErr(404, 'Player not found');
    if (target.id === t.adminId) throw httpErr(400, 'The banker cannot be removed');
    takeOut(t, target, `Banker removed ${target.name} (${target.stack + target.queued} chips)`);
    return { ok: true };
  },
};

// members who tap In sit down with the table's minimum buy-in, no banker step needed
function autoBuyin(t, p) {
  if (p.bought || !p.approved) return;
  const amount = t.settings.minBuyin;
  credit(t, p, amount, 'buyin', 'minimum buy-in');
  say(t, `${p.name} bought in for ${amount}`);
  broadcast(t); maybeStartHand(t);
}
const club = createClub({ tables, makeTable, addPlayer, broadcast, say, httpErr, cleanName, cleanSettings, autoBuyin, publicBase });
Object.assign(routes, club.routes);

function handleEvents(req, res, url) {
  const t = tables.get(String(url.searchParams.get('code') || '').toUpperCase());
  const token = url.searchParams.get('token');
  const p = t && [...t.players.values()].find((x) => x.token === token);
  if (!p) { res.writeHead(401); return res.end(); }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  if (!t.clients.has(p.id)) t.clients.set(p.id, new Set());
  t.clients.get(p.id).add(res);
  p.connected = true;
  send(res, viewFor(t, p.id));
  broadcast(t);
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) { /* closed */ } }, 20000);
  req.on('close', () => {
    clearInterval(ka);
    const set = t.clients.get(p.id);
    if (set) { set.delete(res); if (!set.size) {
      p.connected = false; t.clients.delete(p.id);
      // dropped off during their own turn: shorten the clock
      if (t.hand && !t.hand.finished && t.hand.turnId === p.id) {
        const left = Math.max(0, Math.round((t.deadline - Date.now()) / 1000));
        if (left > DISCONNECT_TURN_SECONDS) armTimer(t, DISCONNECT_TURN_SECONDS);
      }
      broadcast(t);
    } }
  });
}

const INDEX = process.env.INDEX_FILE || path.join(__dirname, 'index.html');
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/statement') {
      const t = getTable(url.searchParams.get('code'));
      const tok = url.searchParams.get('token');
      const fin = t.final || Object.assign(buildFinal(t), { live: true, transfers: [] });
      const asker = fin.people.find((x) => x.token === tok);
      if (!asker) throw httpErr(401, 'You are not at this table');
      const target = url.searchParams.get('pid') || asker.id;
      if (target !== asker.id && !(t.players.has(t.adminId) && t.players.get(t.adminId).token === tok)) throw httpErr(403, 'Only the banker can download someone else\'s statement');
      const pdf = statementPdf(fin, target);
      if (!pdf) throw httpErr(404, 'No statement for that player');
      const who = fin.people.find((x) => x.id === target).name.replace(/[^A-Za-z0-9]+/g, '-');
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="Statement-${who}-${t.code}.pdf"`, 'Cache-Control': 'no-store' });
      return res.end(pdf);
    }
    if (req.method === 'GET' && (url.pathname === '/sw.js' || /^\/icon-(192|512)\.png$/.test(url.pathname))) {
      const file = path.join(__dirname, url.pathname.slice(1));
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : 'image/png', 'Cache-Control': url.pathname.endsWith('.js') ? 'no-cache' : 'public, max-age=86400', 'Service-Worker-Allowed': '/' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      const m = String(url.searchParams.get('m') || '').replace(/[^0-9a-f]/g, '').slice(0, 64);
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        name: 'Smart Buddies', short_name: 'Smart Buddies', start_url: m ? '/?m=' + m : '/', scope: '/', display: 'standalone',
        background_color: '#0a0c0b', theme_color: '#0a0c0b',
        icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
      }));
    }
    const rm = req.method === 'GET' && url.pathname.match(/^\/r\/([0-9a-f]{40})\/([0-9a-f]{8})\/(in|out)$/);
    if (rm) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(club.rsvpPage(rm[1], rm[2], rm[3])); }
    const sm = req.method === 'GET' && url.pathname.match(/^\/s\/([0-9a-f]{36})\.pdf$/);
    if (sm) {
      const l = statementLinks.get(sm[1]), t = l && tables.get(l.code), pdf = t && t.final && statementPdf(t.final, l.pid);
      if (!pdf) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('This statement is no longer available'); }
      const who = t.final.people.find((x) => x.id === l.pid).name.replace(/[^A-Za-z0-9]+/g, '-');
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Statement-${who}-${t.code}.pdf"`, 'Cache-Control': 'no-store' });
      return res.end(pdf);
    }
    if (req.method === 'GET' && url.pathname === '/api/club/events') return club.handleEvents(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/events') return handleEvents(req, res, url);
    if (req.method === 'GET' && url.pathname === '/ping') { res.writeHead(200); return res.end('ok'); }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5);
      if (!Object.prototype.hasOwnProperty.call(routes, name)) throw httpErr(404, 'Unknown request');
      const out = routes[name](await body(req));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(INDEX).pipe(res);
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.status ? e.message : 'Something went wrong' }));
    if (!e.status) console.error(e);
  }
});

// tidy up tables that nobody has touched for 12 hours
setInterval(() => {
  for (const [code, t] of tables) if (!t.clients.size && Date.now() - (t.log.length ? t.log[t.log.length - 1].at : t.createdAt) > 12 * 3600e3) tables.delete(code);
}, 600e3).unref();

// ---------- live tables survive a restart ----------
// A snapshot is a consistent picture between hands: chips are only moved into a hand's own pot and are not taken from a
// player's stack until the hand ends, so a hand that was running when the server stopped is simply cancelled and everyone
// keeps what they had before it.
function dumpTables() {
  const out = {};
  for (const t of tables.values()) {
    if (t.closed) continue;
    const o = {};
    for (const k of Object.keys(t)) if (!['clients', 'timer', 'nextTimer', 'hand', 'players'].includes(k)) o[k] = t[k];
    o.players = [...t.players.values()].map((p) => ({ ...p, connected: false }));
    o.hadHand = !!(t.hand && !t.hand.finished);
    out[t.code] = JSON.parse(JSON.stringify(o));
  }
  return out;
}
let tablesDirty = false, tablesTimer = null;
function markTables() {
  tablesDirty = true;
  if (tablesTimer) return;
  tablesTimer = setTimeout(() => { tablesTimer = null; if (tablesDirty) { tablesDirty = false; try { club.setTables(dumpTables()); } catch (e) { console.error('Could not save tables:', e.message); } } }, Number(process.env.TABLE_SAVE_MS || 8000));
  if (tablesTimer.unref) tablesTimer.unref();
}
function restoreTables() {
  const saved = club.getTables(), now = Date.now();
  let n = 0;
  for (const [code, o] of Object.entries(saved)) {
    const last = o.log && o.log.length ? o.log[o.log.length - 1].at : o.createdAt;
    if (now - last > (o.ended ? 7 * 24 : 24) * 3600e3) continue; // old and untouched
    const t = { ...o, players: new Map(), clients: new Map(), timer: null, nextTimer: null, hand: null, deadline: 0 };
    delete t.hadHand;
    for (const p of o.players) t.players.set(p.id, { ...p, connected: false });
    tables.set(code, t);
    if (t.final) for (const x of t.final.people) statementLinks.set(x.dl, { code, pid: x.id });
    if (o.hadHand) say(t, 'The server restarted. The hand in progress was cancelled and everyone keeps the chips they had before it.');
    else say(t, 'The server restarted. Play continues in a moment.');
    if (t.running && !t.ended) t.nextTimer = setTimeout(() => maybeStartHand(t), Number(process.env.RESTORE_DELAY_MS || 8000));
    n++;
  }
  if (n) console.log(`Restored ${n} live table${n === 1 ? '' : 's'} from storage`);
}
const ready = club.load().then(restoreTables);
ready.catch(() => {}); // reported where it matters (startup below)
setInterval(() => {
  for (const t of tables.values()) {
    if (t.sessionNo > 0 && !t.ended && !t.sessionEnding && Date.now() >= t.sessionEndsAt) {
      t.sessionEnding = true;
      say(t, `Session ${t.sessionNo} time is up. Deck change after this hand.`);
      broadcast(t);
      if (t.running && !(t.hand && !t.hand.finished)) maybeStartHand(t);
    }
  }
}, 2000).unref();
const clubTimer = setInterval(() => { try { club.tick(); } catch (e) { console.error(e); } }, 5000);
clubTimer.unref();

// a deploy or restart: write everything out before stopping
async function shutdown() {
  try { club.setTables(dumpTables()); await club.flush(); } catch (e) { console.error('Final save failed:', e.message); }
  process.exit(0);
}
if (require.main === module) {
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  ready.then(() => server.listen(PORT, () => console.log('Smart Buddies listening on ' + PORT)))
    .catch((e) => { console.error('Not starting: the club data could not be read (' + e.message + '). Check DRIVE_SCRIPT_URL and DRIVE_SECRET.'); process.exit(1); });
}
module.exports = { server, tables, routes, club, ready, startSession, deckChange };
