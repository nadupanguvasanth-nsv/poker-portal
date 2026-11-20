'use strict';
// Smart Buddies server. No dependencies: plain Node http + server-sent events.
// Game state lives in memory. Private cards are only ever sent to their owner.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Hand } = require('./engine');
const { createClub } = require('./club');

const PORT = process.env.PORT || 3000;
const NEXT_HAND_DELAY_MS = Number(process.env.NEXT_HAND_DELAY_MS || 7000);
const tables = new Map();

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
    maxBuyin: clampInt(s.maxBuyin, bb, 1e9, old.maxBuyin || bb * 200),
    maxSeats: 10,
  };
}

function makeTable(adminName, settings) {
  const t = {
    code: newCode(), createdAt: Date.now(), settings: cleanSettings(settings),
    players: new Map(), order: new Array(10).fill(null), adminId: null,
    hand: null, handNo: 0, running: false, buttonSeat: -1,
    pending: [], log: [], clients: new Map(), timer: null, nextTimer: null,
    deadline: 0, lastResult: null, closed: false,
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
  };
  t.players.set(p.id, p);
  t.order[seat] = p.id;
  return p;
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
function say(t, text) { t.log.push({ at: Date.now(), text }); if (t.log.length > 40) t.log.shift(); }
const nameOf = (t, id) => (t.players.get(id) || { name: '?' }).name;

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
      seat: s, id, name: p.name, isAdmin: id === t.adminId, connected: p.connected, away: p.away,
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
      queued: me.queued, bought: me.bought, inHand: seats[me.seat].inHand, away: me.away,
      can: Object.fromEntries(ROLE_NAMES.map((r) => [r, can(t, me, r)])), member: !!me.memberId,
    },
    seats,
    hand: hv && { street: hv.street, board: hv.board, pot: hv.pot, currentBet: hv.currentBet, turnId: hv.turnId, finished: hv.finished, legal: hv.legal, deadline: t.deadline },
    result: t.lastResult,
    log: t.log.slice(-12),
    pending: can(t, me, 'bank') ? t.pending : t.pending.filter((r) => r.playerId === pid),
    ledger: me.ledger.slice(-30),
    history: me.history,
  };
}

function send(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function broadcast(t) {
  for (const [pid, set] of t.clients) {
    if (!t.players.has(pid)) continue;
    const v = viewFor(t, pid);
    for (const res of set) { try { send(res, v); } catch (e) { /* closed */ } }
  }
}

// ---------- game flow ----------
function eligibleSeats(t) {
  const out = [];
  for (let s = 0; s < t.order.length; s++) {
    const id = t.order[s];
    if (!id) continue;
    const p = t.players.get(id);
    if (p.stack > 0 && !p.leaving && !p.away) out.push(p);
  }
  return out;
}

function maybeStartHand(t) {
  if (t.closed || !t.running || (t.hand && !t.hand.finished)) return;
  const el = eligibleSeats(t);
  if (el.length < 2) { t.lastResult = t.lastResult; return; }
  // next button: first eligible seat after the previous button
  let btn = el[0];
  for (let k = 1; k <= 10; k++) {
    const s = (t.buttonSeat + k) % 10;
    const cand = el.find((p) => p.seat === s);
    if (cand) { btn = cand; break; }
  }
  t.buttonSeat = btn.seat;
  const players = el.map((p) => ({ id: p.id, seat: p.seat, stack: p.stack }));
  const buttonIdx = players.findIndex((p) => p.id === btn.id);
  t.handNo++;
  t.lastResult = null;
  t.hand = new Hand({ players, buttonIdx, sb: t.settings.sb, bb: t.settings.bb });
  say(t, `Hand ${t.handNo}: ${btn.name} has the button`);
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
  if (h && h.turnId) {
    const tp = t.players.get(h.turnId);
    const secs = tp && !tp.connected ? Math.min(t.settings.turnSeconds, DISCONNECT_TURN_SECONDS) : t.settings.turnSeconds;
    armTimer(t, secs);
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
  // players removed while the hand was running
  for (const p of [...t.players.values()]) {
    if (p.leaving && !(h.players.some((x) => x.id === p.id))) removePlayer(t, p);
    else if (p.leaving) removePlayer(t, p);
  }
  const r = h.result;
  const names = (id) => nameOf(t, id);
  t.lastResult = {
    handNo: t.handNo, uncontested: r.uncontested, board: h.board.slice(),
    reveal: Object.fromEntries(Object.entries(r.reveal).map(([id, v]) => [id, { name: names(id), ...v }])),
    won: Object.entries(r.won).map(([id, amount]) => ({
      id, name: names(id), amount,
      handName: r.reveal[id] ? r.reveal[id].handName : null,
    })),
    pots: r.pots.length,
  };
  for (const w of t.lastResult.won) say(t, `${w.name} wins ${w.amount}${w.handName ? ' with ' + w.handName.toLowerCase() : ''}`);
  t.deadline = 0;
  broadcast(t);
  clearTimeout(t.nextTimer);
  t.nextTimer = setTimeout(() => maybeStartHand(t), r.uncontested ? NEXT_HAND_DELAY_MS : Math.max(NEXT_HAND_DELAY_MS, Math.min(NEXT_HAND_DELAY_MS * 2, 14000)));
}

function removePlayer(t, p) {
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
  } else { removePlayer(t, p); broadcast(t); }
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
    const amount = clampInt(b.amount, 1, t.settings.maxBuyin, 0);
    if (!amount) throw httpErr(400, `Enter an amount up to ${t.settings.maxBuyin}`);
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
  settings(b) {
    const { t, p } = auth(b); need(t, p, 'settings');
    t.settings = cleanSettings(b.settings, t.settings);
    say(t, `Blinds are now ${t.settings.sb}/${t.settings.bb} from the next hand`);
    broadcast(t);
    return { ok: true };
  },
  start(b) {
    const { t, p } = auth(b); need(t, p, 'start');
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
  leave(b) {
    const { t, p } = auth(b);
    if (p.id === t.adminId) throw httpErr(400, 'The admin cannot leave. Pause the game instead.');
    takeOut(t, p, `${p.name} left the table with ${p.stack + p.queued}`);
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

const club = createClub({ tables, makeTable, addPlayer, broadcast, say, httpErr, cleanName, cleanSettings });
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

const ready = club.load();
ready.catch(() => {}); // reported where it matters (startup below)
const clubTimer = setInterval(() => { try { club.tick(); } catch (e) { console.error(e); } }, 5000);
clubTimer.unref();

if (require.main === module) {
  ready.then(() => server.listen(PORT, () => console.log('Smart Buddies listening on ' + PORT)))
    .catch((e) => { console.error('Not starting: the club data could not be read (' + e.message + '). Check DRIVE_SCRIPT_URL and DRIVE_SECRET.'); process.exit(1); });
}
module.exports = { server, tables, routes, club, ready };
