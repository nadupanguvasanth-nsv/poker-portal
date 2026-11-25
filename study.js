'use strict';
// What the portal can work out about how people play, from its own records and nothing else.
//
// There are two kinds of thing in here and it matters which is which.
//
// The first is counting. How often somebody puts money in before the flop, how often he raises
// rather than calls, how often he bets the flop having raised before it. These are facts: the
// portal watched every hand and it is adding up what it saw. They can be wrong only if the
// counting is wrong.
//
// The second is equity - what each hand was worth at the moment the betting stopped and the rest
// was down to the cards. That is arithmetic over every way the board could have finished, and it
// is exact wherever the count is small enough to finish: two cards to come is 990 boards, one is
// 44. Before the flop there are too many, so it is sampled, and the figure says so.
//
// What is NOT in here is advice. Nothing in this file knows what you should have done. It knows
// what you did and what it was worth, which is a different thing and the only one the portal is
// in a position to say.
const { evalHand } = require('./engine');

// How a hand is written down in the records. The order of these two lists IS the format - an
// action stored as [0, 3, 2, 60] means preflop, raise, the third player in the hand, to 60 - so
// nothing may be reordered or removed, only added to the end. Older records would read as
// something else entirely.
const STUDY_STREETS = ['preflop', 'flop', 'turn', 'river'];
const STUDY_KINDS = ['sb', 'bb', 'ante', 'fold', 'check', 'call', 'bet', 'raise', 'allin'];

// Back into the shape the counting reads.
function expand(rec) {
  if (!rec || !rec.a) return rec;                 // already in the long form
  const players = (rec.p || []).map((id, i) => ({ id: String(i), seat: i, memberId: id }));
  const acts = rec.a.map((x) => ({ s: STUDY_STREETS[x[0]], k: STUDY_KINDS[x[1]], id: String(x[2]), a: x[3] }));
  const won = {}; (rec.w || []).forEach((v, i) => { if (v) won[String(i)] = v; });
  const reveal = {}; (rec.sh || []).forEach((v, i) => { if (v) reveal[String(i)] = 1; });
  let allIn = null;
  if (rec.ai) {
    const ids = (rec.ai.i || []).map((i) => String(i));
    const cards = {};
    ids.forEach((id, k) => { cards[id] = rec.ai.c[k]; });
    allIn = { board: rec.ai.b || [], cards, ids };
  }
  return { no: rec.no, pot: rec.pot, players, acts, won, reveal, allIn };
}

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const DECK = [];
for (const r of RANKS) for (const s of SUITS) DECK.push(r + s);

// ---------------------------------------------------------------- equity
// Every way the board can finish, scored. Exact when that is a number we can count to; sampled
// when it is not, and the result says which it was.
const PREFLOP_SAMPLES = Number(process.env.EQUITY_SAMPLES || 4000);

function equities(board, cards, ids) {
  const used = board.concat(...ids.map((id) => cards[id] || []));
  const rest = DECK.filter((c) => !used.includes(c));
  const need = 5 - board.length;
  const share = {};
  for (const id of ids) share[id] = 0;
  let boards = 0;

  const score = (full) => {
    let best = -1;
    let who = [];
    for (const id of ids) {
      const sc = evalHand('holdem', cards[id], full).score;
      if (sc > best) { best = sc; who = [id]; }
      else if (sc === best) who.push(id);
    }
    for (const id of who) share[id] += 1 / who.length;
    boards += 1;
  };

  if (need === 0) {
    score(board);
    return { exact: true, boards, eq: share };
  }

  // Counting every board outright is only sensible while there are few of them. Two cards to
  // come is under a thousand; five is millions, and a game should not wait for that.
  const combos = (n, k) => { let out = 1; for (let i = 0; i < k; i++) out = out * (n - i) / (i + 1); return Math.round(out); };
  const exact = combos(rest.length, need) <= 25000;

  if (exact) {
    const pick = (start, got) => {
      if (got.length === need) return score(board.concat(got));
      for (let i = start; i < rest.length; i++) pick(i + 1, got.concat([rest[i]]));
    };
    pick(0, []);
  } else {
    for (let s = 0; s < PREFLOP_SAMPLES; s++) {
      const d = rest.slice();
      for (let i = d.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = d[i]; d[i] = d[j]; d[j] = t; }
      score(board.concat(d.slice(0, need)));
    }
  }
  const eq = {};
  for (const id of ids) eq[id] = share[id] / boards;
  return { exact, boards, eq };
}

// ---------------------------------------------------------------- counting
// A blank sheet for one player.
const sheet = () => ({
  hands: 0, won: 0, net: 0,
  vpipN: 0, pfrN: 0,
  threeBetN: 0, threeBetChance: 0,
  faced3Bet: 0, foldedTo3Bet: 0,
  cbetN: 0, cbetChance: 0,
  facedCbet: 0, foldedToCbet: 0,
  aggressive: 0, passive: 0,
  sawFlop: 0, showdowns: 0, wonAtShowdown: 0,
  allIns: 0, allInEquity: 0, allInWon: 0, allInPaid: 0, sampled: 0,
});

// One hand, as the portal wrote it down, turned into marks on everybody's sheet.
//
// The order of the betting before the flop is what tells a raise from a re-raise: the first raise
// is an open, the second is a three-bet, and whoever faced one either gave it up or did not. The
// acts are in the order they happened, which is all that is needed to see that.
function readHand(rec, sheets, opts) {
  // A seat belongs to one night; a person goes on for years. Everything is counted against the
  // member, where the record says who that was, so a figure means the same thing across every
  // game he has ever played rather than restarting each time he sits down.
  const who = {};
  for (const p of rec.players || []) who[p.id] = p.memberId || p.id;
  const by = (id) => { const k = who[id] || id; return (sheets[k] = sheets[k] || sheet()); };
  const acts = rec.acts || [];
  const players = rec.players || [];
  if (!players.length) return;

  // Every action already carries the street it happened on, so they sort themselves.
  const streets = { preflop: [], flop: [], turn: [], river: [] };
  for (const a of acts) if (streets[a.s]) streets[a.s].push(a);

  // An all-in is written down as an all-in whether the man was calling with his last chips or
  // putting them in over the top, so the two have to be told apart by the figure: more than
  // anybody has put in so far is a raise, anything else is a call. Reading every all-in as a
  // raise would make the quiet player with a short stack look like the table's biggest bully.
  const sorted = (list) => {
    let high = 0;
    return list.map((a) => {
      const k = a.k;
      let kind = k;
      if (k === 'allin') { kind = a.a > high ? 'raise' : 'call'; }
      if (kind === 'raise' || kind === 'bet' || kind === 'call' || k === 'sb' || k === 'bb') {
        if (a.a > high) high = a.a;
      }
      return { id: a.id, kind, raw: k, a: a.a };
    });
  };

  for (const p of players) by(p.id).hands += 1;

  // ---- before the flop ----
  const pre = sorted(streets.preflop);
  let raises = 0;
  let opener = '';
  let threeBettor = '';
  const faced3 = new Set();
  const voluntary = new Set();
  const inAtOpen = new Set(players.map((p) => p.id));
  for (const a of pre) {
    if (a.raw === 'sb' || a.raw === 'bb' || a.raw === 'ante') continue;
    const s = by(a.id);
    if (a.kind === 'raise' || a.kind === 'bet') {
      raises += 1;
      voluntary.add(a.id);
      s.aggressive += 1;
      if (raises === 1) { s.pfrN += 1; opener = a.id; }
      else if (raises === 2) { s.threeBetN += 1; threeBettor = a.id; if (opener && opener !== a.id) faced3.add(opener); }
    } else if (a.kind === 'call') {
      voluntary.add(a.id);
      s.passive += 1;
    } else if (a.kind === 'fold') {
      if (faced3.has(a.id)) s.foldedTo3Bet += 1;
    }
  }
  for (const id of voluntary) by(id).vpipN += 1;
  for (const id of faced3) by(id).faced3Bet += 1;
  // whoever was still in when somebody opened had the chance to put in a re-raise
  if (opener) for (const id of inAtOpen) if (id !== opener) by(id).threeBetChance += 1;
  void threeBettor;

  // ---- the flop. A continuation bet is a bet by whoever raised last before it ----
  const flop = sorted(streets.flop);
  const onFlop = new Set(flop.map((a) => a.id));
  for (const id of onFlop) by(id).sawFlop += 1;
  if (opener && onFlop.has(opener)) by(opener).cbetChance += 1;

  let cbet = '';
  for (const a of flop) {
    const s = by(a.id);
    if (a.kind === 'raise' || a.kind === 'bet') {
      if (!cbet && a.id === opener) { s.cbetN += 1; }
      if (!cbet) cbet = a.id;
      s.aggressive += 1;
    } else if (a.kind === 'call') {
      s.passive += 1;
      if (cbet && cbet !== a.id) s.facedCbet += 1;
    } else if (a.kind === 'fold') {
      if (cbet && cbet !== a.id) { s.facedCbet += 1; s.foldedToCbet += 1; }
    }
  }

  // ---- later streets: who was pushing and who was tagging along ----
  for (const st of ['turn', 'river']) {
    for (const a of sorted(streets[st] || [])) {
      const s = by(a.id);
      if (a.kind === 'raise' || a.kind === 'bet') s.aggressive += 1;
      else if (a.kind === 'call') s.passive += 1;
    }
  }

  // ---- how it ended ----
  const won = rec.won || {};
  const reveal = rec.reveal || {};
  const shown = Object.keys(reveal);
  if (shown.length > 1) {
    for (const id of shown) {
      const s = by(id);
      s.showdowns += 1;
      if (won[id]) s.wonAtShowdown += 1;
    }
  }
  for (const p of players) if (won[p.id]) by(p.id).won += 1;

  // ---- and what the pot was worth when the cards took over ----
  if (rec.allIn && rec.allIn.ids && rec.allIn.ids.length > 1 && !(opts && opts.skipEquity)) {
    const e = equities(rec.allIn.board || [], rec.allIn.cards || {}, rec.allIn.ids);
    const pot = rec.pot || 0;
    for (const id of rec.allIn.ids) {
      const s = by(id);
      s.allIns += 1;
      if (!e.exact) s.sampled += 1;
      s.allInEquity += (e.eq[id] || 0) * pot;
      s.allInWon += won[id] || 0;
    }
  }
}

// ---------------------------------------------------------------- the report
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function report(hands, opts) {
  const sheets = {};
  for (const rec of hands) readHand(expand(rec), sheets, opts);
  const out = {};
  for (const [id, s] of Object.entries(sheets)) {
    out[id] = {
      hands: s.hands,
      vpip: pct(s.vpipN, s.hands),
      pfr: pct(s.pfrN, s.hands),
      threeBet: pct(s.threeBetN, s.threeBetChance),
      foldTo3Bet: pct(s.foldedTo3Bet, s.faced3Bet),
      cbet: pct(s.cbetN, s.cbetChance),
      foldToCbet: pct(s.foldedToCbet, s.facedCbet),
      wtsd: pct(s.showdowns, s.sawFlop),
      wonAtShowdown: pct(s.wonAtShowdown, s.showdowns),
      // bets and raises against calls. One means he raises as often as he calls.
      aggression: s.passive ? Math.round((s.aggressive / s.passive) * 100) / 100 : (s.aggressive ? null : 0),
      allIns: s.allIns,
      // what the pots he was all-in for were worth to him, against what he actually took
      dueAllIn: Math.round(s.allInEquity),
      gotAllIn: s.allInWon,
      luck: Math.round(s.allInWon - s.allInEquity),
      sampled: s.sampled,
    };
  }
  return out;
}

// Plain observations, and nothing more than that. Each one is a thing the portal counted, said
// back in words, with the count attached so it can be checked. None of them is advice: the portal
// has no idea what the right frequency is, and a number dressed up as a verdict would be a lie
// told confidently.
function remarks(r) {
  const out = [];
  if (!r || !r.hands || r.hands < 20) return out;
  const n = r.hands;
  if (r.vpip !== null && r.vpip >= 55) out.push(`put money in before the flop in ${r.vpip}% of hands`);
  else if (r.vpip !== null && r.vpip <= 15) out.push(`put money in before the flop in only ${r.vpip}% of hands`);
  if (r.vpip !== null && r.pfr !== null && r.vpip - r.pfr >= 30) {
    out.push(`came in calling far more than raising - ${r.vpip}% in, ${r.pfr}% of it raised`);
  }
  if (r.foldToCbet !== null && r.foldToCbet >= 70) out.push(`folded to ${r.foldToCbet}% of bets on the flop`);
  if (r.foldTo3Bet !== null && r.foldTo3Bet >= 75) out.push(`gave up to ${r.foldTo3Bet}% of re-raises before the flop`);
  if (r.aggression !== null && r.aggression <= 0.4) out.push(`called about ${Math.round(1 / Math.max(r.aggression, 0.05))} times for every bet or raise`);
  if (r.wtsd !== null && r.wtsd >= 45) out.push(`went to a showdown with ${r.wtsd}% of the hands he saw a flop with`);
  if (r.cbet !== null && r.cbetChance !== 0 && r.cbet <= 25) out.push(`bet the flop after raising before it only ${r.cbet}% of the time`);
  if (r.allIns >= 5 && Math.abs(r.luck) > 0) {
    out.push(r.luck < 0
      ? `took ${Math.abs(r.luck).toLocaleString('en-IN')} chips less than the all-ins were worth to him`
      : `took ${r.luck.toLocaleString('en-IN')} chips more than the all-ins were worth to him`);
  }
  void n;
  return out;
}

module.exports = { equities, report, remarks, readHand, expand, STUDY_KINDS, STUDY_STREETS };
