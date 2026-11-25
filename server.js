'use strict';
// Smart Buddies: a private poker portal for one group of friends.
//
// This file is the outside of the portal: the web server, the live feed to each phone, and the
// clock that moves a hand along. The thinking lives next door - portal.js knows the members,
// lobby.js knows the tables, games.js knows the formats, engine.js plays the cards.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { makeStore } = require('./store');
const { makePeople } = require('./portal');
const { makeLobby } = require('./lobby');
const { Table, FORMATS, PICKABLE, SEATS, TOURNEY, NO_CAP, VARIANTS } = require('./games');
const { CATEGORY } = require('./engine');
const { settle, statementPdf } = require('./statement');
const { START_GRACE_MS, ROUND_TO, YELLOW_AFTER_MS, RED_AFTER_MS, RED_AT_DEBTS } = require('./house');
const webpush = require('./webpush');

const PORT = Number(process.env.PORT || 3000);
const NEXT_HAND_MS = Number(process.env.NEXT_HAND_MS || 4000);
const SHOW_MS = Number(process.env.SHOW_MS || 8000);
const RUNIT_SECONDS = Number(process.env.RUNIT_SECONDS || 20);   // how long the run-it vote waits
const FX_GAP_MS = 900;                                           // one reaction at a time, per player
const FX_LIFE_MS = 6000;                                         // how long one stays on the table

// Things you can lob at somebody, and what it turns into when it lands.
const FX_THROW = {
  bomb: ['\uD83D\uDCA3', '\uD83D\uDCA5'], tomato: ['\uD83C\uDF45', '\uD83D\uDCA6'],
  flower: ['\uD83C\uDF39', '\uD83C\uDF38'], heart: ['\u2764\uFE0F', '\uD83D\uDC95'],
  beer: ['\uD83C\uDF7A', '\uD83C\uDF7B'], ice: ['\uD83E\uDDCA', '\u2744\uFE0F'],
  fire: ['\uD83D\uDD25', '\uD83D\uDD25'], cash: ['\uD83D\uDCB8', '\uD83E\uDD11'],
  crown: ['\uD83D\uDC51', '\u2728'], shoe: ['\uD83D\uDC5E', '\uD83D\uDCAB'],
};
// Things you put up over your own seat.
const FX_FACE = {
  laugh: '\uD83D\uDE02', cry: '\uD83D\uDE2D', cool: '\uD83D\uDE0E', angry: '\uD83D\uDE21',
  shock: '\uD83D\uDE31', shh: '\uD83E\uDD2B', pray: '\uD83D\uDE4F', clap: '\uD83D\uDC4F',
  smirk: '\uD83D\uDE0F', clown: '\uD83E\uDD21', think: '\uD83E\uDD14', salute: '\uD83E\uDEE1',
  yawn: '\uD83E\uDD71', strong: '\uD83D\uDCAA', eyes: '\uD83D\uDC40', sweat: '\uD83D\uDE05',
};
// The table's own reactions, nobody sends these.
const FX_AUTO = { win: '\uD83C\uDF89', bust: '\uD83D\uDC80', scoop: '\uD83D\uDD25' };

// Tell people's phones something happened. Never waits: a phone that cannot be reached must not
// hold up the person who tapped the button, and a subscription the service has thrown away is
// dropped quietly rather than retried for ever.
function notify(ids, payload) {
  if (!state.vapid) { console.log('push: no key yet, nothing sent'); return 0; }
  // Who is sending. Apple checks this and refuses the whole push with 403 if it is not a real
  // mailto: or https: address - a made-up domain is not good enough. The portal's own address
  // always is, so use that unless something better is set.
  const here = publicUrl();
  const subject = process.env.PUSH_CONTACT || (/^https:/i.test(here) ? here.replace(/\/$/, '') : 'mailto:smartbuddies@gmail.com');
  let tried = 0;
  const asleep = [];
  for (const id of ids) {
    const m = state.members[id];
    if (!m) continue;
    if (m.pushOff) { asleep.push(m.name + ' (switched off)'); continue; }
    if (!m.subs || !m.subs.length) { asleep.push(m.name + ' (no phone signed up)'); continue; }
    tried += m.subs.length;
  }
  // Say what happened. A push that never arrives is otherwise completely silent, and there is
  // nothing to look at when somebody says "I did not get it".
  console.log(`push: "${payload.title}" to ${tried} phone(s)` + (asleep.length ? '; skipped ' + asleep.join(', ') : ''));
  (async () => {
    for (const id of ids) {
      const m = state.members[id];
      if (!m || m.pushOff || !m.subs || !m.subs.length) continue;
      for (const sub of m.subs.slice()) {
        const where = (sub.endpoint || '').slice(0, 40);
        try {
          const r = await webpush.send(sub, payload, state.vapid, subject);
          if (r.gone) {
            console.log(`push: ${m.name}'s phone is no longer signed up (${r.status}), forgetting it`);
            m.subs = m.subs.filter((s) => s.endpoint !== sub.endpoint);
            changed();
          } else if (!r.ok) {
            console.log(`push: ${m.name} refused with ${r.status}${r.why ? ' - ' + r.why : ''} (sent as ${subject})`);
          }
        } catch (err) {
          console.log(`push: could not reach ${m.name}'s phone (${err.message}) at ${where}`);
        }
      }
    }
  })().catch((err) => console.log('push: gave up - ' + err.message));
  return tried;
}

function pushFx(t, k, from, to, icon, hit) {
  const now = Date.now();
  t.fxSeq = (t.fxSeq || 0) + 1;
  t.fx = (t.fx || []).filter((f) => now - f.at < FX_LIFE_MS).slice(-20);
  t.fx.push({ id: t.fxSeq, k, from: from || null, to: to || null, at: now, icon, hit: hit || '' });
}

// A hand worth a noise: somebody took a big one, or somebody ran out of chips.
// Worth looking up from your phone for: a pot that changes the night, or a hand you will still be
// talking about next week. The size of a pot only means anything next to the blinds being played,
// so it is measured in big blinds rather than in chips.
const SHOUT = { 'Straight flush': 2, 'Four of a kind': 2, 'Full house': 1, Flush: 1, Straight: 1 };

// What beats what, as people expect to read it. The engine scores a royal flush as the ace-high
// straight flush, which is right - there is no separate category to score - but it is the hand
// everybody looks for by name, and the table already announces it by name when one lands. A book
// that leaves it out reads as though the portal does not know about it.
const RANKING = ['Royal flush', ...CATEGORY.slice().reverse()];
function celebrate(t, h) {
  const won = (h.result && h.result.won) || {};
  const reveal = (h.result && h.result.reveal) || {};
  const big = t.blinds().bb * 20;
  let best = null;
  for (const id of Object.keys(won)) {
    if (won[id] >= big * 2) pushFx(t, 'scoop', null, id, FX_AUTO.scoop);
    else if (won[id] >= big) pushFx(t, 'win', null, id, FX_AUTO.win);

    // the hand itself, if it was shown; otherwise just how much of a pot it was
    const name = reveal[id] && reveal[id].handName;
    const byHand = name ? (SHOUT[name] || 0) : 0;
    const byPot = won[id] >= big * 4 ? 2 : won[id] >= big * 2 ? 1 : 0;
    const level = Math.max(byHand, byPot);
    if (!level) continue;
    const who = t.players.get(id);
    const title = byHand >= byPot && name ? name.toUpperCase() : 'BIG POT';
    if (!best || level > best.level) best = { level, title, who: who ? who.name : '' };
  }
  if (best) {
    const now = Date.now();
    t.fxSeq = (t.fxSeq || 0) + 1;
    t.fx = (t.fx || []).filter((f) => now - f.at < FX_LIFE_MS).slice(-20);
    t.fx.push({ id: t.fxSeq, kind: 'sky', at: now, level: best.level, title: best.title, who: best.who });
  }
  for (const p of t.seated()) if (p.stack <= 0) pushFx(t, 'bust', null, p.id, FX_AUTO.bust);
}
const KEEP_ENDED_H = Number(process.env.KEEP_ENDED_H || 48);
const ROUNDS_KEPT = Number(process.env.ROUNDS_KEPT || 10);

const httpErr = (code, message) => Object.assign(new Error(message), { status: code });

// ---------------------------------------------------------------- state
let state = { members: {}, history: [], vapid: null };
const store = makeStore(process.env);
let dirty = false;
const changed = () => { dirty = true; };

function snapshot() {
  return {
    members: state.members,
    history: state.history,
    vapid: state.vapid,
    tables: [...lobby.tables.values()].filter((t) => keepTable(t)).map(saveTable),
  };
}
const saveTimer = setInterval(() => { if (dirty) { dirty = false; store.save(snapshot()); } }, Number(process.env.SAVE_TICK_MS || 4000));
if (saveTimer.unref) saveTimer.unref();

// A table is worth keeping across a restart while it is live, and for a day or two after it ends
// so people can still read the result.
function keepTable(t) {
  if (t.status !== 'ended') return true;
  return Date.now() - (t.endedAt || 0) < KEEP_ENDED_H * 3600e3;
}
// Everything about a table except the things that cannot be written down: the hand in progress,
// the live timers, and the players, which are a Map.
const NOT_SAVED = ['hand', 'players', 'fx', 'fxLast', 'clients', 'timer', 'nextTimer', 'startTimer', 'deadline'];
function saveTable(t) {
  const o = {};
  for (const k of Object.keys(t)) if (!NOT_SAVED.includes(k)) o[k] = t[k];
  o.players = [...t.players.values()];
  // Once a game is over its record is in the history with the replays and the accounts, so keeping
  // a second copy on the table for the two days it hangs around only doubles what goes to Drive.
  if (t.status === 'ended') { o.rounds = []; o.log = t.log.slice(-5); o.notes = []; }
  return o;
}

// Bring a table back after a restart. Render puts the service to sleep and wakes it again, so a
// game in progress has to survive that. The hand that was in the air is cancelled and everybody
// keeps the chips they had before it, because the chips on the table are only banked when a hand
// finishes. Whoever runs the table taps Start and play carries on.
function restoreTable(raw) {
  try {
    const t = Object.create(Table.prototype);
    Object.assign(t, raw);
    t.players = new Map((raw.players || []).map((p) => [p.id, p]));
    t.hand = null;
    t.timer = null; t.nextTimer = null; t.deadline = 0;
    t.fx = [];
    if (t.status === 'playing') { t.status = 'waiting'; t.say('The portal restarted. The hand in progress was cancelled and everyone keeps the chips they had before it.'); }
    lobby.tables.set(t.code, t);
  } catch (err) {
    console.error('Could not bring back table', raw && raw.code, err.message);
  }
}

// ---------------------------------------------------------------- live feed
const feeds = new Set();                     // every open event stream

function sendTo(client, event, data) {
  try { client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (err) { /* gone */ }
}
function broadcast(t) {
  for (const c of feeds) {
    if (c.code !== t.code) continue;
    sendTo(c, 'table', tableView(t, c.member));
  }
}
function broadcastLobby() {
  for (const c of feeds) sendTo(c, 'lobby', { tables: lobby.list(c.member) });
}
function tellMember(memberId, event, data) {
  for (const c of feeds) if (c.member.id === memberId) sendTo(c, event, data);
}

// ---------------------------------------------------------------- the pieces
const people = makePeople({ state, changed, httpErr, secret: () => process.env.DRIVE_SECRET || process.env.SETUP_SECRET || '' });
const lobby = makeLobby({ state, changed, httpErr, people, broadcast });

// ---------------------------------------------------------------- the view each phone gets
function handView(t, me) {
  const h = t.hand;
  if (!h) return null;
  const show = h.finished && h.result ? h.result.reveal || {} : {};
  return {
    no: t.handNo, variant: h.variant, variantName: VARIANTS[h.variant].name,
    street: h.street, pot: h.pot, boards: h.boards, boardKind: h.boardKind,
    currentBet: h.currentBet, finished: h.finished,
    button: h.players[h.buttonIdx] ? h.players[h.buttonIdx].seat : -1,
    turnId: h.turn >= 0 && !h.finished ? h.players[h.turn].id : '',
    deadline: t.deadline || 0,
    result: h.finished ? h.result : null,
    runit: h.runit ? { voters: h.runit.voters, votes: h.runit.votes, max: h.maxRuns() } : null,
    // the move just made, so the table can see it land on the player who made it. The count is
    // what makes it a new move: the same player calling twice running is two separate flashes.
    lastAct: (h.acts && h.acts.length)
      ? { n: h.acts.length, id: h.acts[h.acts.length - 1].id, k: h.acts[h.acts.length - 1].k, a: h.acts[h.acts.length - 1].a }
      : null,
    players: h.players.map((p) => ({
      id: p.id, seat: p.seat, bet: p.bet, stack: p.stack, folded: p.folded, allIn: p.allIn,
      // your own cards always; everyone else's only once they are shown
      cards: (me && p.id === me.id) ? p.cards : (show[p.id] ? show[p.id].cards || p.cards : p.cards.map(() => '??')),
      // The ones they chose to turn over. Choosing can happen at any point in the hand - a player
      // decides early that he will show - but it is only carried out once the hand is over. Turning
      // a card face up while the betting is still going would hand everybody else free information.
      shown: (h.finished && p.shown && p.shown.length) ? p.cards.map((c, i) => (p.shown.indexOf(i) >= 0 ? c : '??')) : null,
      // and what he has marked so far goes back to him alone, so his own screen can show the
      // choice he made without any of it reaching the rest of the table before the hand is over
      willShow: (me && p.id === me.id && p.shown && p.shown.length) ? p.shown.slice() : null,
    })),
  };
}

function tableView(t, member) {
  const mine = t.byMember(member.id);
  const iRun = lobby.runs(t, member);
  const b = t.blinds();
  return {
    now: Date.now(),
    code: t.code, title: t.title, format: t.format, formatName: FORMATS[t.format].name,
    variant: t.variant, variantName: t.variant ? VARIANTS[t.variant].name : '',
    admin: t.adminName, adminId: t.adminId, iRunIt: iRun,
    status: t.status, handNo: t.handNo, startedAt: t.startedAt, endedAt: t.endedAt,
    paused: !!t.paused, lastHands: t.lastHands || 0, endAt: t.endAt || 0,
    blinds: b, settings: t.settings, seatsMax: SEATS,
    level: t.format === 'tournament' ? t.level : 0,
    levelAt: t.format === 'tournament' ? t.levelAt : 0,
    waiting: t.status === 'waiting' ? t.canStart() : '',
    // say so before it happens, so nobody is surprised by the variant hand
    nextVariant: t.format === 'mixed' && t.variant && t.nextSeat(t.button) === t.varButton ? VARIANTS[t.variant].name : '',
    varSeat: t.format === 'mixed' ? t.varButton : -1,
    seats: t.seats.map((id, seat) => {
      if (!id) return null;
      const p = t.players.get(id);
      if (!p || p.out) return null;
      return {
        id: p.id, seat, name: p.name, stack: p.stack, bought: p.bought,
        away: !!p.away, busted: !!p.busted, place: p.place || 0,
        leaveAsk: !!p.leaveAsk, leaveOk: !!p.leaveOk,
        isAdmin: p.memberId === t.adminId, me: !!(mine && p.id === mine.id),
      };
    }),
    me: mine ? { id: mine.id, memberId: mine.memberId, seat: mine.seat, stack: mine.stack, bought: mine.bought, away: !!mine.away, out: !!mine.out,
      topUp: mine.topUp || 0, auto: !!mine.auto, inPlay: inPlay(t, mine),
      canLeave: t.servedTime(mine), forfeit: !!mine.forfeit, asked: !!mine.leaveAsk,
      freeAt: (t.settings.minMinutes || 0) ? (mine.joinedAt || t.createdAt) + t.settings.minMinutes * 60000 : 0 } : null,
    legal: mine && t.hand && !t.hand.finished ? (t.hand.legal(mine.id) || null) : null,
    hand: handView(t, mine),
    requests: iRun ? t.requests.slice() : [],
    leaveAsks: iRun ? t.seated().filter((p) => p.leaveAsk && !p.leaveOk).map((p) => ({ id: p.id, name: p.name })) : [],
    notes: t.notes.slice(-10),
    log: t.log.slice(-40),
    fx: (t.fx || []).filter((f) => Date.now() - f.at < FX_LIFE_MS).slice(-10),
    reactions: {
      throws: Object.keys(FX_THROW).map((k) => ({ k, icon: FX_THROW[k][0] })),
      faces: Object.keys(FX_FACE).map((k) => ({ k, icon: FX_FACE[k] })),
    },
  };
}

// ---------------------------------------------------------------- the clock
function clearTimers(t) {
  clearTimeout(t.startTimer); t.startTimer = null; clearTimeout(t.timer); clearTimeout(t.nextTimer); t.timer = null; t.nextTimer = null; }

function armTurn(t) {
  clearTimeout(t.timer);
  // Nothing is on the clock while the game is paused: people have gone for a smoke or a plate of
  // food, and nobody should come back to find they were folded for being slow.
  if (t.paused) { t.deadline = 0; return; }
  const h = t.hand;
  if (!h || h.finished) return;

  // Everyone is all-in and the table is voting on running the board more than once. That needs a
  // clock as much as a turn does: somebody always puts their phone down mid-hand, and with nothing
  // ticking the hand would sit there for good and the night with it. No vote means run it once.
  if (h.runit) {
    t.deadline = Date.now() + RUNIT_SECONDS * 1000;
    t.timer = setTimeout(() => {
      if (t.hand !== h || !h.runit) return;
      h.resolveRunIt();
      t.say('Nobody finished voting, so the board is dealt once.');
      afterAction(t);
    }, RUNIT_SECONDS * 1000 + 300);
    return;
  }

  if (h.turn < 0) return;
  t.deadline = Date.now() + t.settings.turnSeconds * 1000;
  t.timer = setTimeout(() => {
    const p = h.players[h.turn];
    if (!p) return;
    const L = h.legal(p.id);
    try { h.act(p.id, L && L.canCheck ? 'check' : 'fold'); } catch (err) { /* already moved on */ }
    const who = t.players.get(p.id);
    if (who) { who.away = true; t.say(`${who.name} ran out of time and is sitting out`); }
    afterAction(t);
  }, t.settings.turnSeconds * 1000 + 300);
}

// Somebody is in play if the hand being dealt has a copy of their stack: whatever happens to the
// table's copy while that is true is thrown away when the hand writes itself back.
function inPlay(t, p) {
  const h = t.hand;
  return !!(h && !h.finished && (h.players || []).some((x) => x.id === p.id));
}

// The end of a hand is when chips can safely go on: the hand has written its stacks back and
// nothing is holding a copy of them any more.
// A line of everybody's chips through the night, one point per hand. Without it an account can
// say what somebody finished with but nothing about how they got there, which is the part people
// actually argue about afterwards. Past a cap it thins itself rather than growing without end.
const SAMPLE_CAP = Number(process.env.SAMPLE_CAP || 400);
function takeSample(t) {
  t.curve = t.curve || {};
  for (const p of t.list()) {
    const line = (t.curve[p.id] = t.curve[p.id] || []);
    line.push([t.handNo, p.stack]);
    if (line.length > SAMPLE_CAP) {
      const thin = [];
      for (let i = 0; i < line.length; i += 2) thin.push(line[i]);
      thin.push(line[line.length - 1]);
      t.curve[p.id] = thin;
    }
  }
}

function topUpAll(t) {
  for (const p of t.seated()) {
    let add = p.topUp || 0;
    p.topUp = 0;
    // and anybody who said to buy them back in, now that they have run out
    if (!add && p.auto && p.stack <= 0) add = t.settings.minBuyin;
    if (!add) continue;
    t.give(p, add);
    t.say(`${p.name} is back in for ${add}`);
  }
}

function afterAction(t) {
  const h = t.hand;
  if (!h) return;
  if (h.finished) {
    t.settle();
    takeSample(t);                   // where everybody stood at the end of this hand
    topUpAll(t);                     // only now: the hand has written everybody's stack back
    keepRound(t, h);
    celebrate(t, h);
    broadcast(t);
    const winner = t.tourneyWinner();
    if (winner) return endGame(t, `${winner.name} won the tournament`);
    const wait = h.result && !h.result.uncontested ? SHOW_MS : NEXT_HAND_MS;
    clearTimeout(t.nextTimer);
    // The table is wrapping up: either the game admin called the last few hands, or he asked to
    // close and the hand in progress was allowed to finish first. Either way it runs out here,
    // after the same pause that lets everybody see how the hand went.
    if (t.lastHands) {
      t.lastHands -= 1;
      if (t.lastHands <= 0) {
        t.lastHands = 0;
        t.say('That was the last hand.');
        broadcast(t);
        t.nextTimer = setTimeout(() => endGame(t, 'The last hand has been played'), wait);
        return;
      }
      t.say(`${t.lastHands} more hand${t.lastHands === 1 ? '' : 's'} to go`);
    }
    t.nextTimer = setTimeout(() => nextHand(t), wait);
    return;
  }
  armTurn(t);
  broadcast(t);
}

// A table that has enough people gets going on its own. Waiting for somebody to notice and tap a
// button is how a game sits at four players for ten minutes while everybody assumes somebody else
// is about to start it. There is a few seconds' grace so the fourth person is not dealt in before
// their thumb has left the screen, and it is called off if somebody stands up again in that time.
// What anybody can say at a table. Nothing here needs typing, and nothing here is free text:
// the whole point is that it can be sent one-handed with a hand in progress.
const SAYINGS = {
  // from a player
  five:    { text: 'Back in five minutes' },
  deal:    { text: 'Deal me out a hand or two', acts: 'out' },
  backin:  { text: "I'm back - deal me in", acts: 'back' },
  slow:    { text: 'Sorry, my connection is poor' },
  oneorbit:{ text: 'One more orbit and I am done' },
  nice:    { text: 'Nice hand' },
  leave:   { text: 'I need to leave early', acts: 'leave' },
  topup:   { text: 'Buy me back in if I run out', acts: 'buyback' },
  pausepls:{ text: 'Can we take a short break?' },
  // from whoever runs it
  soon:    { text: 'Starting in a minute', admin: true },
  yours:   { text: 'Your turn - are you there?', admin: true },
  brk:     { text: 'Taking a short break', admin: true },
  wrap:    { text: 'We are wrapping up soon', admin: true },
  paypls:  { text: 'Please settle up when you can', admin: true },
};

function maybeAutoStart(t) {
  if (!t) return;
  if (t.status !== 'waiting' || t.paused || t.canStart()) {
    // Somebody stood up or stepped away while the table was counting down. Stop the countdown at
    // once rather than letting it run and fail, but say so - a countdown that simply goes quiet
    // leaves everybody watching a number that is never coming.
    if (t.startTimer) {
      clearTimeout(t.startTimer); t.startTimer = null;
      t.say('Not enough players any more - waiting');
      broadcast(t); broadcastLobby();
    }
    return;
  }
  if (t.startTimer) return;                       // already counting down
  const secs = Math.round(START_GRACE_MS / 1000);
  t.say(`${t.ready().length} players are in - starting in ${secs} seconds`);
  broadcast(t); broadcastLobby();
  t.startTimer = setTimeout(() => {
    t.startTimer = null;
    if (t.status !== 'waiting' || t.paused) return;
    if (t.canStart()) { t.say('Not enough players any more - waiting'); broadcast(t); return; }
    nextHand(t);
  }, START_GRACE_MS);
}

function nextHand(t) {
  if (t.status === 'ended' || t.paused) return;
  // anybody the game admin let go, or who is out of a tournament, leaves now
  for (const p of t.seated()) {
    if (p.leaveOk) t.stand(p, 'leaving early, blinds waived');
    else if (p.forfeit && t.servedTime(p)) t.stand(p, 'stayed to the end of his time and left');
    else if (t.format === 'tournament' && p.busted) t.stand(p, 'out');
  }
  if (t.format === 'tournament') {
    const w = t.tourneyWinner();
    if (w) return endGame(t, `${w.name} won the tournament`);
  }
  t.tickLevel();
  const why = t.canStart();
  if (why) { t.status = t.startedAt ? 'waiting' : t.status; t.say(why); broadcast(t); broadcastLobby(); return; }
  try { t.deal(); } catch (err) { t.say(err.message); broadcast(t); return; }
  armTurn(t);
  changed(); broadcast(t); broadcastLobby();
}

// Keep the most eventful hands so they can be replayed later.
// What makes a hand worth keeping. The pot is the usual measure, but the hand people will still
// be talking about next week is not always the one that moved the most chips - quads that nobody
// paid off are worth more to watch again than a routine big pot. So a hand earns its place either
// way, and the rare ones are capped at half the slots so one freak hand cannot crowd out the
// night's real pots.
const MONSTER = { 'Straight flush': 2, 'Four of a kind': 1 };
const MONSTER_SLOTS = Math.max(1, Math.floor(ROUNDS_KEPT / 2));
function handTier(h) {
  const reveal = (h.result && h.result.reveal) || {};
  const won = (h.result && h.result.won) || {};
  let best = 0, label = '';
  for (const id of Object.keys(won)) {
    const r = reveal[id];
    if (!r || !r.handName) continue;
    const rank = MONSTER[r.handName] || 0;
    if (rank > best) {
      best = rank;
      // the engine knows no separate royal flush; it is the ace-high one, and worth saying
      label = (r.handName === 'Straight flush' && (r.best || []).some((c) => c[0] === 'A') && (r.best || []).some((c) => c[0] === 'K'))
        ? 'Royal flush' : r.handName;
    }
  }
  return { tier: best, label };
}

function keepRound(t, h) {
  if (!h.result) return;
  const m = handTier(h);
  const rec = {
    no: t.handNo, at: Date.now(), variant: h.variant, pot: h.pot,
    tier: m.tier, label: m.label,
    boards: h.boards, acts: h.acts,
    players: h.players.map((p) => ({ id: p.id, seat: p.seat, name: (t.players.get(p.id) || {}).name || '', start: p.start })),
    reveal: h.result.reveal || {}, won: h.result.won || {},
  };
  t.rounds.push(rec);
  // the rare ones first, then the biggest pots fill what is left
  const rare = t.rounds.filter((r) => r.tier).sort((a, b) => (b.tier - a.tier) || (b.pot - a.pot)).slice(0, MONSTER_SLOTS);
  const keepIds = new Set(rare.map((r) => r.no));
  const rest = t.rounds.filter((r) => !keepIds.has(r.no)).sort((a, b) => b.pot - a.pot);
  t.rounds = rare.concat(rest).slice(0, ROUNDS_KEPT);
}

// ---------------------------------------------------------------- ending a game
// Round every stack to the nearest step, then put whatever the rounding invented or lost onto
// the biggest stack, so the total is exactly what was in play.
function roundStacks(players, step) {
  const out = {};
  let total = 0, after = 0, biggest = null;
  for (const p of players) {
    total += p.stack;
    const r = Math.round(p.stack / step) * step;
    out[p.id] = r; after += r;
    if (!biggest || p.stack > biggest.stack) biggest = p;
  }
  if (biggest && after !== total) out[biggest.id] -= (after - total);
  return out;
}

function endGame(t, why) {
  if (t.status === 'ended') return;
  clearTimers(t);
  t.status = 'ended';
  t.endedAt = Date.now();
  t.hand = null;
  t.say(why || 'The game has ended');

  // A table where no hand was ever dealt has nothing to settle: everybody still holds exactly what
  // they bought in with. A record of all zeroes in the accounts helps nobody and buries the real
  // games, so it is closed without one.
  if (!t.handNo) {
    changed();
    broadcast(t); broadcastLobby();
    for (const p of t.list()) tellMember(p.memberId, 'ended', { code: t.code, id: '' });
    return null;
  }

  const b = t.blinds();
  // Settle in round numbers. Nobody wants to be told they owe 11,663. Rounding each stack on its
  // own does NOT keep the total - three stacks each rounding up invent 150 chips out of nothing -
  // so whatever the rounding made or lost lands on the biggest stack: one named person, the
  // smallest distortion, and the books tally exactly as they must.
  const rounded = roundStacks(t.list(), ROUND_TO);

  const people_ = t.list().map((p) => ({
    id: p.id, memberId: p.memberId, name: p.name,
    invested: p.bought, final: rounded[p.id], net: rounded[p.id] - p.bought, rawFinal: p.stack,
    place: p.place || 0, busted: p.busted || 0,
    carried: 0, ledger: p.ledger, history: [], sessions: [],
  }));
  const record = {
    id: t.code + '-' + t.createdAt.toString(36),
    code: t.code, title: t.title || FORMATS[t.format].name,
    format: t.format, formatName: FORMATS[t.format].name,
    variant: t.variant, variantName: t.variant ? VARIANTS[t.variant].name : '',
    adminId: t.adminId, admin: t.adminName,
    startedAt: t.startedAt || t.createdAt, endedAt: t.endedAt, at: t.endedAt, hands: t.handNo,
    sb: b.sb, bb: b.bb, sessions: 1, live: false,
    people: people_,
    curve: t.curve || {},                    // everybody's chips, hand by hand
    // Who pays who, named by member rather than by seat. A player id belongs to one night at one
    // table; a debt outlives both, and everything that acts on it afterwards - marking it paid,
    // confirming it, the flags, the books - knows people by their membership. Settling on seat
    // ids made records that looked perfectly right and that nobody could ever mark as paid.
    transfers: settle(people_.map((p) => ({ ...p, id: p.memberId || p.id }))),
    rounds: t.rounds,
  };
  if (t.format === 'tournament') {
    const sorted = [...people_].sort((a, b) => b.final - a.final);
    record.winner = sorted[0] ? sorted[0].name : '';
    record.losers = sorted.slice(1).map((p) => p.name);
  }
  state.history.unshift(record);
  pruneReplays();
  changed();
  broadcast(t); broadcastLobby();
  for (const p of t.list()) tellMember(p.memberId, 'ended', { code: t.code, id: record.id });

  // Everybody who played gets told on their phone, whether or not they are still looking at the
  // portal. The person most likely to have shut it is the one who left early - and he is the one
  // who most needs to know what the night came to and who he owes.
  for (const person of people_) {
    const owes = (record.transfers || []).filter((x) => x.from === person.id);
    const owed = (record.transfers || []).filter((x) => x.to === person.id);
    let line;
    if (owes.length) line = `You owe ${owes.map((x) => `${x.toName} ${x.amount.toLocaleString('en-IN')}`).join(', ')}.`;
    else if (owed.length) line = `${owed.map((x) => `${x.fromName} ${x.amount.toLocaleString('en-IN')}`).join(', ')} to come to you.`;
    else line = 'You finished level.';
    notify([person.memberId], {
      title: 'The game is over',
      body: `${record.formatName}: you ${person.net > 0 ? 'are up ' : person.net < 0 ? 'are down ' : 'finished on '}`
        + `${Math.abs(person.net).toLocaleString('en-IN')}. ${line}`,
      url: '/', tag: 'done-' + t.code, badge: 1,
    });
  }
  return record;
}

// Replays for the last few games; the accounts stay for good.
function pruneReplays() {
  let kept = 0;
  for (const g of state.history) {
    if (!g.rounds || !g.rounds.length) continue;
    kept += 1;
    if (kept > Number(process.env.REPLAY_GAMES || 10)) delete g.rounds;
  }
}

// ---------------------------------------------------------------- routes
const routes = {
  // --- getting in ---
  'first-admin': (b) => people.firstAdmin(b),
  'sign-in': (b) => people.signIn(b),
  'look-up': (b) => people.lookUp(b),
  'sign-out': (b) => { people.signOut(b.token); return { ok: true }; },

  me(b) {
    const m = people.auth(b);
    return {
      me: people.publicMember(m),
      tables: lobby.list(m),
      // The portal admin is given everybody's flags with the list, because a statistics page
      // that shows who is up and down but not who owes money is the half of it he does not need.
      members: m.isAdmin
        ? people.members().map((x) => ({ ...people.publicMember(x), flags: flagsFor(x.id) }))
        : [],
      formats: Object.entries(FORMATS).map(([id, f]) => ({ id, ...f })),
      // the whole spec of each game, so the rule book is written out of the rules themselves
      variants: PICKABLE.map((id) => ({ id, name: VARIANTS[id].name })),
      games: Object.keys(VARIANTS).map((id) => {
        const v = VARIANTS[id];
        return { id, name: v.name, hole: v.hole, omaha: !!v.omaha, boards: v.boards, bomb: !!v.bomb, pl: !!v.pl, max: v.max };
      }),
      ranking: RANKING,
      seats: SEATS, tourney: TOURNEY,
      history: myHistory(m),
      adminName: adminName(),          // who to ask, when the answer is "ask him"
      storage: m.isAdmin ? store.name : '',
      saveError: m.isAdmin ? store.error() : '',
      push: { key: state.vapid ? state.vapid.publicKey : '', on: !!(m.subs && m.subs.length) && !m.pushOff },
      // what is outstanding, so nobody has to go looking for it
      flags: flagsFor(m.id),
      toPay: openDebts().filter((d) => d.from === m.id),
      toGet: openDebts().filter((d) => d.to === m.id),
      flagged: m.isAdmin
        ? Object.values(state.members).filter((x) => x.red).map((x) => ({ id: x.id, name: x.name, why: x.red.why, at: x.red.at }))
        : [],
    };
  },
  // A phone asking to be told when something happens. One member may have a few: a phone, an
  // iPad, the same phone after a reinstall. Keep the last four and let the dead ones fall away.
  'push-on'(b) {
    const m = people.auth(b);
    const sub = b.sub;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      throw httpErr(400, 'That is not something the portal can send to');
    }
    m.subs = (m.subs || []).filter((s2) => s2.endpoint !== sub.endpoint);
    m.subs.push({ endpoint: String(sub.endpoint).slice(0, 600), keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, at: Date.now() });
    if (m.subs.length > 4) m.subs = m.subs.slice(-4);
    m.pushOff = false;
    changed();
    return { on: true };
  },
  'push-off'(b) {
    const m = people.auth(b);
    m.subs = [];
    m.pushOff = true;
    changed();
    return { on: false };
  },
  'push-test'(b) {
    const m = people.auth(b);
    const tried = notify([m.id], { title: 'Smart Buddies', body: 'That is working. You will hear from the table.', url: '/', tag: 'test', badge: 1, force: true });
    return { sent: tried, phones: (m.subs || []).length };
  },

  'set-pin'(b) { const m = people.auth(b); return people.changePin(m, b); },
  rename(b) { const m = people.auth(b); return people.rename(m, b); },

  // --- the admin's list of members ---
  'member-add'(b) { const m = people.auth(b); people.adminOnly(m); return people.add(b); },
  'member-remove'(b) { const m = people.auth(b); people.adminOnly(m); return people.remove(b); },
  'member-reset'(b) { const m = people.auth(b); people.adminOnly(m); return people.resetPin(b); },

  // Primary or secondary: who can get a game going at all. Only the portal admin decides it, and
  // the person it is done to is told, because finding out by being refused is a poor way to learn
  // the rules of a game among friends.
  'member-tier'(b) {
    const m = people.auth(b);
    people.adminOnly(m);
    const who = people.setTier(b);
    if (b.memberId !== m.id) {
      notify([b.memberId], who.tier === 'primary'
        ? { title: 'You can start a game', body: `${m.nick || m.name} made you a primary member. You can open a table now.`, url: '/', badge: 1 }
        : { title: 'Starting games', body: `${m.nick || m.name} made you a secondary member. You play as before; a primary member opens the table.`, url: '/', badge: 1 });
    }
    return who;
  },

  // The message that opens the portal to the group. It names the people who can get a game going,
  // because that is the one thing the group cannot work out for themselves and the first thing
  // they will ask. Written here rather than on the phone so the names are the portal's own answer
  // and not a list somebody typed out and forgot to update.
  'portal-invite'(b) {
    const m = people.auth(b);
    people.adminOnly(m);
    const all = people.members();
    const starters = all.filter((x) => people.canOpen(x)).map((x) => x.nick || x.name).sort((a, c) => a.localeCompare(c));
    const names = starters.length === 1 ? starters[0]
      : starters.slice(0, -1).join(', ') + ' and ' + starters[starters.length - 1];
    const text = `Smart Buddies is open.\n\n${publicUrl()}\n\n`
      + `1. Open that on your phone.\n`
      + `2. Add it to your home screen, so it opens like an app.\n`
      + `3. Sign in with your mobile number - the one I have for you.\n`
      + `4. Choose a 4-digit passcode. That is how you get in from then on.\n\n`
      + (starters.length
        ? `Starting a game: ${names}.\nAnybody else, ask one of them to open a table and then take a seat.\n\n`
        : `Nobody is set up to start a game yet.\n\n`)
      + `Chips are virtual. Seven seats, first come first served.`;
    return { text, starters, count: all.length };
  },

  // --- tables ---
  'table-open'(b) {
    const m = people.auth(b);
    // Secondary members play; primary members get the game going. The check is here rather than
    // only on the button, because a button is a suggestion and a route is the rule.
    if (!people.canOpen(m)) {
      throw httpErr(403, `Only a primary member can start a table. Ask ${adminName()} if you should be one.`);
    }
    const t = lobby.open(m, b);
    broadcastLobby();
    // everybody else's phone, so a game can be got up without chasing people in the group chat
    notify(people.members().map((x) => x.id).filter((id) => id !== m.id), {
      title: 'A table is up',
      body: `${m.nick || m.name} has started ${FORMATS[t.format].name}. ${t.freeSeats()} of ${SEATS} seats free.`,
      url: '/', tag: 'table-' + t.code, badge: 1,
    });
    return { code: t.code, invite: lobby.invite(t, publicUrl()) };
  },
  'table-join'(b) {
    const m = people.auth(b);
    const t = lobby.need(b.code);
    // Somebody who owes money from a previous night does not sit down as if nothing happened. Red
    // keeps him out altogether; yellow turns taking a free seat into asking, so whoever runs the
    // table knows what he is letting in.
    const f = flagsFor(m.id);
    if (f.red) throw httpErr(403, `You have a red flag - ${f.redWhy}. ${adminName()} has to lift it.`);
    if (f.yellow && !lobby.runs(t, m)) {
      if (!t.requests.some((r) => r.memberId === m.id)) {
        t.requests.push({ memberId: m.id, name: m.name, at: Date.now(), flagged: f.yellow });
        broadcast(t); broadcastLobby(); changed();
        notify([t.adminId], {
          title: 'Someone wants in',
          body: `${m.nick || m.name} is asking to join, and owes from ${f.yellow} game${f.yellow === 1 ? '' : 's'}.`,
          url: '/', tag: 'ask-' + t.code, badge: 1,
        });
      }
      return { asked: true, flagged: f.yellow };
    }
    const r = lobby.join(m, b);
    maybeAutoStart(t);
    broadcastLobby();
    // if they had to ask, the person running it needs to know, wherever their phone is
    if (r && r.asked) {
      notify([t.adminId], {
        title: 'Someone wants in',
        body: `${m.nick || m.name} is asking to join your table.`,
        url: '/', tag: 'ask-' + t.code, badge: 1,
      });
    }
    return r;
  },
  'table-decide'(b) {
    const m = people.auth(b);
    const t = lobby.need(b.code);
    const r = lobby.decide(m, b);
    maybeAutoStart(t);            // letting somebody in may be the fourth player
    broadcastLobby();
    if (b.ok && b.memberId) {
      notify([String(b.memberId)], {
        title: 'You are in', body: `${t.adminName} let you in. Tap to take your seat.`,
        url: '/', tag: 'in-' + t.code, badge: 1,
      });
    }
    return r;
  },
  'table-invite'(b) { const m = people.auth(b); const t = lobby.need(b.code); return { text: lobby.invite(t, publicUrl()) }; },

  'table-start'(b) {
    const m = people.auth(b);
    const t = lobby.mustRun(lobby.need(b.code), m);
    if (t.status === 'ended') throw httpErr(400, 'That game has finished');
    if (t.paused) throw httpErr(400, 'The game is paused - start it again first');
    if (t.hand && !t.hand.finished) throw httpErr(400, 'A hand is already running');
    const why = t.canStart();
    if (why) throw httpErr(400, why);
    nextHand(t);
    return { ok: true };
  },
  // Stopping for a bit: the clock stops, no new hand is dealt, and nobody can act until it starts
  // again. Whoever runs the table may do it, which is the person who opened it or the portal admin.
  'table-pause'(b) {
    const m = people.auth(b);
    const t = lobby.mustRun(lobby.need(b.code), m);
    if (t.status === 'ended') throw httpErr(400, 'That game has finished');
    const on = !!b.on;
    if (on !== !!t.paused) {
      if (on) {
        t.paused = Date.now();
        clearTimers(t);
        t.deadline = 0;
        t.say(`${m.name} paused the game`);
      } else {
        t.paused = 0;
        t.say(`${m.name} started the game again`);
        // whoever was to act gets a full turn back, not the two seconds that were left when it stopped
        if (t.hand && !t.hand.finished) armTurn(t);
        else if (t.status === 'playing') { clearTimeout(t.nextTimer); t.nextTimer = setTimeout(() => nextHand(t), 1500); }
      }
      changed(); broadcast(t); broadcastLobby();
    }
    return { paused: !!t.paused };
  },

  // The payer saying he has paid. A claim, not a receipt: it does not settle the debt or lift a
  // flag, but it is on the record and the person owed can see it when he comes to confirm.
  'pay-mark'(b) {
    const m = people.auth(b);
    const g = state.history.find((x) => x.id === b.id);
    if (!g) throw httpErr(404, 'No such game');
    const x = (g.transfers || []).find((y) => y.from === b.from && y.to === b.to);
    if (!x) throw httpErr(404, 'Nothing owed between those two');
    if (x.from !== m.id && !m.isAdmin) throw httpErr(403, 'Only the person paying can mark it paid');
    if (x.confirmedAt) return { already: true };
    x.paidAt = Date.now(); x.paidBy = m.id;
    changed();
    notify([x.to], {
      title: 'Says he has paid you',
      body: `${x.fromName} marked ${x.amount.toLocaleString('en-IN')} as paid. Confirm it when it lands.`,
      url: '/', tag: 'paid-' + g.id, badge: 1,
    });
    return { ok: true, paidAt: x.paidAt };
  },

  // The person owed saying the money arrived. This is what settles it. The portal admin can enter
  // it on his behalf when he cannot be reached - recorded as such, because in anything to do with
  // money who entered a record matters as much as what it says.
  'pay-confirm'(b) {
    const m = people.auth(b);
    const g = state.history.find((x) => x.id === b.id);
    if (!g) throw httpErr(404, 'No such game');
    const x = (g.transfers || []).find((y) => y.from === b.from && y.to === b.to);
    if (!x) throw httpErr(404, 'Nothing owed between those two');
    const onBehalf = x.to !== m.id;
    if (onBehalf && !m.isAdmin) throw httpErr(403, 'Only the person owed can confirm it');
    if (x.confirmedAt) return { already: true };
    x.confirmedAt = Date.now();
    x.confirmedBy = m.id;
    x.confirmedByName = m.name;
    x.onBehalf = onBehalf;
    changed();
    reviewFlags();
    notify([x.from], {
      title: 'Settled',
      body: `${x.toName} confirmed your ${x.amount.toLocaleString('en-IN')}.`
        + (onBehalf ? ` Entered by ${m.name}.` : ''),
      url: '/', tag: 'done-' + g.id,
    });
    return { ok: true, onBehalf };
  },

  // Lifting a red flag. The portal admin's alone, and deliberate: paying clears the yellow by
  // itself, but a red stays until he takes it off.
  'flag-clear'(b) {
    const m = people.auth(b);
    if (!m.isAdmin) throw httpErr(403, 'Only the portal admin can lift a red flag');
    const who = state.members[String(b.memberId || '')];
    if (!who) throw httpErr(404, 'No such member');
    if (!who.red) return { already: true };
    delete who.red;
    changed();
    notify([who.id], { title: 'You are clear', body: `${m.name} lifted your red flag. You can sit down again.`, url: '/', badge: 1 });
    return { ok: true };
  },

  // Calling the last few hands, so everybody knows where they stand before the night ends.
  // Setting it to nothing carries on as before.
  'table-last'(b) {
    const m = people.auth(b);
    const t = lobby.mustRun(lobby.need(b.code), m);
    if (t.status === 'ended') throw httpErr(400, 'That game has finished');
    const n = Math.floor(Number(b.hands));
    if (!Number.isFinite(n) || n < 0 || n > 100) throw httpErr(400, 'A number of hands between 1 and 100');
    t.lastHands = n;
    if (!n) t.say(`${m.name} called the game back on - no last hands after all`);
    else t.say(`${m.name} called the last ${n} hand${n === 1 ? '' : 's'}`);
    changed(); broadcast(t); broadcastLobby();
    return { lastHands: t.lastHands };
  },

  // A time to finish, declared up front so nobody has to ask how much longer. When it comes round
  // the hand being played is still played out - the same rule as closing by hand.
  'table-endat'(b) {
    const m = people.auth(b);
    const t = lobby.mustRun(lobby.need(b.code), m);
    if (t.status === 'ended') throw httpErr(400, 'That game has finished');
    const at = Math.floor(Number(b.at));
    if (!b.at) { t.endAt = 0; t.say(`${m.name} took the finishing time off`); }
    else {
      if (!Number.isFinite(at) || at < Date.now() + 30000) throw httpErr(400, 'Pick a time that is still to come');
      if (at > Date.now() + 24 * 3600e3) throw httpErr(400, 'That is more than a day away');
      t.endAt = at;
      t.say(`${m.name} set the game to finish at ${new Date(at).toLocaleTimeString('en-IN', { timeStyle: 'short', timeZone: process.env.TZ_LABEL || 'Asia/Kolkata' })}`);
    }
    changed(); broadcast(t); broadcastLobby();
    return { endAt: t.endAt || 0 };
  },

  // Closing a table never cuts a hand short: the chips in the middle belong to a hand that is
  // still being played, and whoever is in it deserves to see it out. So if a hand is running the
  // close is booked for the end of it; otherwise it happens now.
  'table-end'(b) {
    const m = people.auth(b);
    const t = lobby.mustRun(lobby.need(b.code), m);
    if (t.status === 'ended') throw httpErr(400, 'That game has finished');
    // A paused table has nothing in play - the hand, if any, is frozen and going nowhere - so
    // waiting for it to finish would wait for ever.
    if (t.hand && !t.hand.finished && !t.paused) {
      t.lastHands = 1;
      t.say(`${m.name} is closing the game - this hand will be played out first`);
      changed(); broadcast(t); broadcastLobby();
      return { record: '', afterHand: true };
    }
    const rec = endGame(t, `${m.name} ended the game`);
    return { record: rec ? rec.id : '', afterHand: false };
  },

  // --- at the table ---
  act(b) {
    const m = people.auth(b);
    const t = lobby.need(b.code);
    const p = t.byMember(m.id);
    if (!p) throw httpErr(403, 'You are not at this table');
    if (t.paused) throw httpErr(400, 'The game is paused');
    if (!t.hand || t.hand.finished) throw httpErr(400, 'No hand is running');
    try { t.hand.act(p.id, b.type, b.amount); } catch (err) { throw httpErr(400, err.message); }
    p.away = false;
    afterAction(t);
    changed();
    return { ok: true };
  },
  // Asking for chips at any point in the game. They never land in the middle of a hand: the hand
  // is being played on its own copy of everybody's stack and writes that copy back when it ends,
  // so chips added underneath it were quietly wiped the moment the hand settled - and the buy-in
  // still counted against the player's account. They wait, and go on at the end of the hand.
  buyin(b) {
    const m = people.auth(b);
    const t = lobby.need(b.code);
    const p = t.byMember(m.id);
    if (!p) throw httpErr(403, 'You are not at this table');
    if (t.format === 'tournament') throw httpErr(400, 'A tournament gives everybody the same chips');
    const amount = Math.floor(Number(b.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw httpErr(400, 'How much?');
    if (amount > t.settings.maxBuyin) {
      // an uncapped table still has a sane ceiling in the numbers; never quote it at anybody
      throw httpErr(400, t.settings.maxBuyin >= NO_CAP ? 'That is more chips than the portal can count'
        : `The most you can buy in for is ${t.settings.maxBuyin}`);
    }
    const waiting = p.topUp || 0;
    if (p.stack + waiting + amount < t.settings.minBuyin && amount < t.settings.minBuyin) {
      throw httpErr(400, `The minimum buy-in is ${t.settings.minBuyin}`);
    }
    if (inPlay(t, p)) {
      p.topUp = waiting + amount;
      t.say(`${p.name} is buying in for ${amount} at the end of this hand`);
      changed(); broadcast(t); broadcastLobby();
      return { stack: p.stack, bought: p.bought, waiting: p.topUp };
    }
    t.give(p, amount);
    t.say(`${p.name} bought in for ${amount}`);
    changed(); broadcast(t); broadcastLobby();
    return { stack: p.stack, bought: p.bought, waiting: 0 };
  },

  // Topping yourself up without having to ask each time: run out, and the table's buy-in goes on
  // at the end of that hand so you are dealt into the next one. Always the buy-in the game was
  // opened with - a switch, not another number to get wrong.
  'auto-buyin'(b) {
    const m = people.auth(b);
    const t = lobby.need(b.code);
    const p = t.byMember(m.id);
    if (!p) throw httpErr(403, 'You are not at this table');
    if (t.format === 'tournament') throw httpErr(400, 'Nobody buys more chips in a tournament');
    p.auto = !!b.on;
    t.say(p.auto
      ? `${p.name} will buy back in for ${t.settings.minBuyin} if the chips run out`
      : `${p.name} turned off buying back in`);
    changed(); broadcast(t); broadcastLobby();
    return { auto: p.auto, amount: t.settings.minBuyin };
  },
  away(b) {
    const m = people.auth(b);
    const t = lobby.need(b.code);
    const p = t.byMember(m.id);
    if (!p) throw httpErr(403, 'You are not at this table');
    p.away = !!b.on;
    t.say(`${p.name} is ${p.away ? 'sitting out' : 'back'}`);
    changed(); broadcast(t);
    // somebody stepping away or coming back changes whether there are enough to begin
    maybeAutoStart(t);
    return { away: p.away };
  },
  'leave-ask'(b) { const m = people.auth(b); return lobby.askLeave(m, b); },
  'leave-decide'(b) { const m = people.auth(b); return lobby.decideLeave(m, b); },
  // Saying something at a table, from a list rather than a keyboard. Typing while a hand is live
  // is the thing nobody does, so there is nothing to type: a few phrases that cover what actually
  // comes up. Some of them are only words; others are the real request, because having a message
  // that says "I need to go" beside a separate button that actually asks is two systems for one
  // conversation, and only one of them moves any chips.
  say(b) {
    const m = people.auth(b);
    const t = lobby.need(b.code);
    const p = t.byMember(m.id);
    const line = SAYINGS[String(b.id || '')];
    if (!line) throw httpErr(400, 'No such message');
    if (line.admin && !lobby.runs(t, m)) throw httpErr(403, 'Only whoever runs the table can say that');
    if (!line.admin && !p) throw httpErr(403, 'You are not at this table');

    // the ones that do something as well as say it
    if (line.acts === 'leave') return { ...lobby.askLeave(m, b), said: line.text };
    if (line.acts === 'buyback') {
      if (t.format === 'tournament') throw httpErr(400, 'Nobody buys more chips in a tournament');
      p.auto = true;
      t.say(`${p.name} will buy back in for ${t.settings.minBuyin} if the chips run out`);
    }
    if (line.acts === 'out' && p) { p.away = true; t.say(`${p.name} is sitting out`); }
    if (line.acts === 'back' && p) { p.away = false; t.say(`${p.name} is back`); }

    const who = line.admin ? (b.to ? String(b.to) : '') : t.adminId;
    const msg = { id: Math.random().toString(36).slice(2, 8), from: m.id, fromName: m.nick || m.name,
      to: who, text: line.text, at: Date.now() };
    t.notes.push(msg);
    if (t.notes.length > 30) t.notes.shift();
    changed(); broadcast(t);
    if (line.acts === 'back' || line.acts === 'out') maybeAutoStart(t);
    return { ok: true, said: line.text };
  },
  // Showing your cards when you did not have to. At a real showdown the cards come up on their
  // own; this is for the hand everybody folded, where showing is a choice - one card, or both.
  showcards(b) {
    const m = people.auth(b);
    const t = lobby.need(b.code);
    const p = t.byMember(m.id);
    if (!p) throw httpErr(400, 'You are not at this table');
    const h = t.hand;
    if (!h) throw httpErr(400, 'There is no hand to show');
    const hp = (h.players || []).filter((x) => x.id === p.id)[0];
    if (!hp || !hp.cards || !hp.cards.length) throw httpErr(400, 'You have no cards to show');
    const want = Array.isArray(b.idx) ? b.idx : [];
    hp.shown = want
      .map((i) => Math.floor(Number(i)))
      .filter((i) => i >= 0 && i < hp.cards.length)
      .filter((i, k, a) => a.indexOf(i) === k);
    broadcast(t);
    return { ok: true };
  },

  // fun: lob something at another player, or put a face up over your own seat
  react(b) {
    const m = people.auth(b);
    const t = lobby.need(b.code);
    const p = t.byMember(m.id);
    if (!p || p.out) throw httpErr(400, 'You are not at this table');
    const k = String(b.kind || '');
    const now = Date.now();
    t.fxLast = t.fxLast || {};
    if (now - (t.fxLast[p.id] || 0) < FX_GAP_MS) throw httpErr(429, 'One at a time');
    if (FX_THROW[k]) {
      const q = t.players.get(String(b.to));
      if (!q || q.id === p.id || q.out) throw httpErr(400, 'Pick somebody else at the table');
      t.fxLast[p.id] = now;
      pushFx(t, k, p.id, q.id, FX_THROW[k][0], FX_THROW[k][1]);
    } else if (FX_FACE[k]) {
      t.fxLast[p.id] = now;
      pushFx(t, k, p.id, null, FX_FACE[k]);
    } else throw httpErr(400, 'No such reaction');
    broadcast(t);
    return { ok: true };
  },
  runit(b) {
    const m = people.auth(b);
    const t = lobby.need(b.code);
    const p = t.byMember(m.id);
    if (!p || !t.hand || !t.hand.runit) throw httpErr(400, 'Nothing to vote on');
    try { t.hand.vote(p.id, Math.floor(Number(b.runs)) || 1); } catch (err) { throw httpErr(400, err.message); }
    afterAction(t);
    return { ok: true };
  },

  // --- records ---
  replay(b) {
    const m = people.auth(b);
    const g = state.history.find((x) => x.id === b.id);
    if (!g) throw httpErr(404, 'No such game');
    if (!m.isAdmin && !g.people.some((p) => p.memberId === m.id)) throw httpErr(403, 'You did not play in that one');
    return { rounds: g.rounds || [] };
  },

  // Taking a game out of the records. Only the portal admin, and only him: a game is everybody's
  // account of who owes who, so a player cannot quietly remove one he did badly in. It goes for
  // good - the replays with it - which is why the app asks before calling this.
  'history-remove'(b) {
    const m = people.auth(b);
    if (!m.isAdmin) throw httpErr(403, 'Only the portal admin can remove a game from the records');
    const i = state.history.findIndex((x) => x.id === b.id);
    if (i < 0) throw httpErr(404, 'No such game');
    const [gone] = state.history.splice(i, 1);
    changed();
    for (const p of gone.people) tellMember(p.memberId, 'ended', { code: gone.code, id: '' });
    return { removed: gone.id, title: gone.title || gone.formatName, at: gone.at };
  },
};

function myHistory(m) {
  return state.history
    .filter((g) => m.isAdmin || g.people.some((p) => p.memberId === m.id))
    .slice(0, 60)
    .map((g) => ({ ...g, rounds: undefined, replays: g.rounds ? g.rounds.length : 0 }));
}

const publicUrl = () => process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// ---------------------------------------------------------------- settling up
// A debt is settled when the person owed says he has been paid, and not before. The payer can say
// he has paid, and that is worth recording, but it is a claim rather than a receipt - in a game
// where everybody knows everybody, one person's word that money arrived is the only thing worth
// treating as true.

// every debt in the records that is still open, oldest first
function openDebts() {
  const out = [];
  for (const g of state.history) {
    for (const x of g.transfers || []) {
      if (x.confirmedAt) continue;
      out.push({
        gameId: g.id, at: g.at, title: g.title, when: g.at,
        from: x.from, fromName: x.fromName, to: x.to, toName: x.toName,
        amount: x.amount, paidAt: x.paidAt || 0, paidBy: x.paidBy || '',
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// Yellow is worked out rather than stored, so paying clears it the moment the receipt is
// confirmed and nobody has to remember to lift it. Red is stored, because it stays until the
// portal admin lifts it by hand even after the money has arrived.
function flagsFor(memberId) {
  const now = Date.now();
  const mine = openDebts().filter((d) => d.from === memberId);
  const yellow = mine.filter((d) => now - d.at > YELLOW_AFTER_MS);
  const m = state.members[memberId];
  const red = !!(m && m.red);
  return {
    yellow: red ? 0 : yellow.length,
    red,
    redWhy: red ? m.red.why : '',
    redAt: red ? m.red.at : 0,
    owes: mine.length,
    oldestAt: mine.length ? mine[0].at : 0,
  };
}

// Anything that has gone past the long window, or anybody carrying too many at once, turns red
// and stays red. Run on a timer and after anything that could change it.
function reviewFlags() {
  const now = Date.now();
  const by = {};
  for (const d of openDebts()) (by[d.from] = by[d.from] || []).push(d);
  let changed_ = false;
  for (const [memberId, debts] of Object.entries(by)) {
    const m = state.members[memberId];
    if (!m || m.red) continue;
    const old = debts.find((d) => now - d.at > RED_AFTER_MS);
    // Three at once means three that have gone yellow, not three that merely exist. Somebody who
    // loses three games in one evening has not done anything wrong yet - nobody could have paid
    // that fast - and barring him for it would punish losing rather than not settling up.
    const yellows = debts.filter((d) => now - d.at > YELLOW_AFTER_MS);
    const why = old ? `a debt unsettled for more than ${Math.round(RED_AFTER_MS / 3600e3)} hours`
      : yellows.length >= RED_AT_DEBTS ? `${yellows.length} games unsettled at once` : '';
    if (!why) continue;
    m.red = { at: now, why };
    changed_ = true;
    notify([memberId], {
      title: 'You cannot sit down',
      body: `${why}. Settle up and ask ${adminName()} to lift it.`,
      url: '/', tag: 'red', badge: 1,
    });
  }
  if (changed_) changed();
}
function adminName() {
  const a = Object.values(state.members).find((m) => m.isAdmin);
  return a ? a.name : 'the portal admin';
}

// ---------------------------------------------------------------- http
// Served from here rather than squeezed into the page as a data: URI, because that is the one
// thing the phone reads when somebody adds the portal to their home screen, and phones are fussy
// about where it comes from. One less file to upload, too.
const MANIFEST = JSON.stringify({
  name: 'Smart Buddies', short_name: 'Smart Buddies',
  display: 'standalone', orientation: 'portrait',
  background_color: '#0a0c0b', theme_color: '#0a0c0b',
  start_url: '/', scope: '/',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/sw.js': ['sw.js', 'application/javascript'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/poster.jpg': ['poster.jpg', 'image/jpeg'],
};

// Nonsense arrives sooner or later - a half-sent request, a stray crawler, a bug in a phone.
// Answer it plainly rather than with a stack trace, so the log only ever shows real trouble.
// The page carries {{BASE}} in its link-preview tags so a shared link shows a card in WhatsApp
// rather than a bare address. Only the portal knows what it is being served as, so fill it here.
function indexHtml() {
  const raw = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  return raw.split('{{BASE}}').join(publicUrl().replace(/\/$/, ''));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      data += c;
      if (data.length > 1e6) { over = true; reject(httpErr(413, 'that is too much to send at once')); req.destroy(); }
    });
    req.on('end', () => {
      if (over) return;
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (err) { reject(httpErr(400, 'that was not a request the portal understands')); }
    });
    req.on('error', (err) => { if (!over) reject(httpErr(400, 'the request did not arrive in one piece')); });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/ping') { res.writeHead(200); return res.end('ok'); }

    if (req.method === 'GET' && url.pathname === '/api/feed') return feed(req, res, url);

    if (req.method === 'GET' && url.pathname === '/api/statement') {
      const m = people.whoIs(url.searchParams.get('token'));
      if (!m) { res.writeHead(401); return res.end('sign in'); }
      const g = state.history.find((x) => x.id === url.searchParams.get('id'));
      if (!g) { res.writeHead(404); return res.end('no such game'); }
      if (!m.isAdmin && !g.people.some((p) => p.memberId === m.id)) { res.writeHead(403); return res.end('not yours'); }
      // Your own statement, or - for the portal admin, who keeps the books - any player's, asked
      // for by seat. Without one named he gets the first player's, which is what he had before.
      const who = url.searchParams.get('who');
      const mine = (m.isAdmin && who ? g.people.find((p) => p.id === who) : null)
        || g.people.find((p) => p.memberId === m.id)
        || (m.isAdmin ? g.people[0] : null);
      if (!mine) { res.writeHead(403); return res.end('not yours'); }
      const pdf = statementPdf(g, mine.id);
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${g.title.replace(/\W+/g, '-')}.pdf"` });
      return res.end(pdf);
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5);
      const fn = routes[name];
      if (!fn) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"no such thing"}'); }
      const body = await readBody(req);
      const out = await fn(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out || { ok: true }));
    }

    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'max-age=86400' });
      return res.end(MANIFEST);
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const body = indexHtml();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(body);
    }

    const file = FILES[url.pathname];
    if (req.method === 'GET' && file) {
      const full = path.join(__dirname, file[0]);
      if (!fs.existsSync(full)) { res.writeHead(404); return res.end('not built yet'); }
      res.writeHead(200, { 'content-type': file[1], 'cache-control': file[0].endsWith('.html') ? 'no-cache' : 'max-age=86400' });
      return res.end(fs.readFileSync(full));
    }
    res.writeHead(404); res.end('not found');
  } catch (err) {
    const code = err.status || 500;
    if (code === 500) console.error(err);
    if (res.headersSent) return;
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err.message || 'something went wrong' }));
  }
});

function feed(req, res, url) {
  const m = people.whoIs(url.searchParams.get('token'));
  if (!m) { res.writeHead(401); return res.end('sign in'); }
  const code = (url.searchParams.get('code') || '').toUpperCase();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 2000\n\n');
  const client = { res, member: m, code };
  feeds.add(client);
  sendTo(client, 'lobby', { tables: lobby.list(m) });
  const t = code && lobby.get(code);
  if (t) sendTo(client, 'table', tableView(t, m));
  const beat = setInterval(() => { try { res.write(': .\n\n'); } catch (err) { /* gone */ } }, 25000);
  req.on('close', () => { clearInterval(beat); feeds.delete(client); });
}

// the tournament clock, and letting go of games nobody is looking at any more
const OPEN_MINUTES = Number(process.env.OPEN_MINUTES || 30);
const tick = setInterval(() => {
  for (const t of lobby.tables.values()) {
    if (t.format === 'tournament' && t.status === 'playing' && t.tickLevel()) broadcast(t);
    // A table opened and never got going is somebody who changed their mind, or a message that
    // nobody answered. It closes itself rather than sitting in everyone's list for days. A paused
    // table is left alone: somebody is plainly still there, they have just stopped for a while.
    // The time the game was set to finish. A paused table is left where it is - its clock is off -
    // and picks this up when it starts again.
    if (t.status !== 'ended' && t.endAt && !t.paused && Date.now() >= t.endAt) {
      t.endAt = 0;
      if (t.hand && !t.hand.finished) {
        if (!t.lastHands) t.lastHands = 1;
        t.say('Time is up. This hand is played out and then the game closes.');
        changed(); broadcast(t);
      } else {
        endGame(t, 'The game reached the time it was set to finish');
      }
    }
    if (t.status !== 'ended' && !t.handNo && !t.paused && Date.now() - t.createdAt > OPEN_MINUTES * 60000) {
      endGame(t, `Nobody started this game within ${OPEN_MINUTES} minutes, so it closed itself`);
    }
    if (t.status === 'ended' && !keepTable(t)) lobby.forget(t.code);
  }
  reviewFlags();          // debts do not age quietly
}, 10000);
if (tick.unref) tick.unref();

// ---------------------------------------------------------------- start
const ready = (async () => {
  const saved = await store.load().catch((err) => {
    console.error('Could not read the portal data:', err.message);
    if (process.env.DRIVE_SCRIPT_URL) { console.error('Not starting: the portal data could not be read.'); process.exit(1); }
    return null;
  });
  // Starting the portal over. The old portal kept its members and games in a different shape, and
  // reading those in would leave people on the list who have no number and no passcode. Clearing
  // the file by hand does not work while the service is up, because it still has the old data in
  // memory and writes it back. So this does it at the one moment nothing can: before the first
  // save. Set FRESH_START=1, start the service, check the list is empty, then take it off again.
  if (saved && process.env.FRESH_START === '1') {
    console.log('FRESH_START is set: ignoring what was stored and beginning with an empty portal.');
    console.log('Take FRESH_START off once you have set yourself up, or the next restart wipes it again.');
  } else if (saved) {
    // Take each part only if it is the shape we expect. A file written by an older build, or one
    // that got garbled, must never stop the portal starting: the service would crash-loop on boot
    // and the whole thing would be dead with nothing obviously wrong. Keep what makes sense, say
    // out loud what was dropped, carry on.
    const dropped = [];
    const ok = (v, kind) => (kind === 'array' ? Array.isArray(v) : !!v && typeof v === 'object' && !Array.isArray(v));

    if (ok(saved.members, 'object')) state.members = saved.members;
    else if (saved.members !== undefined) dropped.push('members');

    if (ok(saved.history, 'array')) state.history = saved.history;
    else if (saved.history !== undefined) dropped.push('history');

    state.vapid = saved.vapid || null;

    if (ok(saved.tables, 'array')) for (const raw of saved.tables) restoreTable(raw);
    else if (saved.tables !== undefined) dropped.push('tables');

    if (dropped.length) {
      console.error(`The stored data had ${dropped.join(' and ')} in a shape this portal does not use, so ${dropped.length > 1 ? 'they were' : 'it was'} left out.`);
      console.error('If this is the old portal\'s data, start once with FRESH_START=1 to begin cleanly.');
    }
  }
  if (!state.vapid) { state.vapid = webpush.makeVapid(); changed(); }
  if (process.env.FRESH_START === '1') changed();        // overwrite the old file straight away
  console.log(`Storage: ${store.name}, ${Object.keys(state.members).length} members, ${state.history.length} games on record`);
})();

if (require.main === module) {
  ready.then(() => server.listen(PORT, () => console.log('Smart Buddies on ' + PORT)));
}

module.exports = { server, ready, routes, lobby, people, state, store, endGame, tableView, broadcast, httpErr, handTier };
