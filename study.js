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
  const players = (rec.p || []).map((id, i) => ({ id: String(i), seat: i, memberId: id, start: (rec.st || [])[i] || 0 }));
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
  const hole = {};
  (rec.c || []).forEach((cs, i) => { if (cs && cs.length) hole[String(i)] = cs; });
  return { no: rec.no, pot: rec.pot, bb: rec.bb || 0, players, acts, won, reveal, allIn, board: rec.b || [], hole };
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
  riverCalls: 0, riverGood: 0, riverNeeded: 0,
  pos: { btn: { hands: 0, vpip: 0, pfr: 0 }, blind: { hands: 0, vpip: 0, pfr: 0 }, other: { hands: 0, vpip: 0, pfr: 0 } },
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

  // The same two counts again, by where he was sitting. Three places and no more: on the button,
  // in the blinds, and everywhere else. Finer than that and a night's hands are spread too thin
  // to say anything; and those three are the ones that play differently.
  const btn = buttonOf(rec);
  const blinds = new Set(acts.filter((a) => a.k === 'sb' || a.k === 'bb').map((a) => a.id));
  for (const p of players) {
    const where = by(p.id).pos[p.id === btn ? 'btn' : blinds.has(p.id) ? 'blind' : 'other'];
    where.hands += 1;
    if (voluntary.has(p.id)) where.vpip += 1;
    if (opener === p.id) where.pfr += 1;
  }
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

  // ---- the calls on the river, for the tally ----
  for (const c of riverCalls(rec)) {
    const s = by(c.id);
    s.riverCalls += 1; s.riverGood += c.good; s.riverNeeded += c.needed;
  }

  // ---- and what the pot was worth when the cards took over ----
  if (rec.allIn && rec.allIn.ids && rec.allIn.ids.length > 1 && !(opts && opts.skipEquity)) {
    const e = equities(rec.allIn.board || [], rec.allIn.cards || {}, rec.allIn.ids);
    const pot = rec.pot || 0;
    // In big blinds when the hand knows its own stakes, so two nights at different stakes can be
    // added together honestly. One night at 100/200 and one at 25/50 do not share a chip.
    const unit = rec.bb || 1;
    for (const id of rec.allIn.ids) {
      const s = by(id);
      s.allIns += 1;
      if (!e.exact) s.sampled += 1;
      s.allInEquity += ((e.eq[id] || 0) * pot) / unit;
      s.allInWon += (won[id] || 0) / unit;
      // One night counted in blinds and another in chips cannot be added together, and the
      // figure that came out of it would be nonsense wearing whichever label happened to be
      // last. Mixed is recorded as mixed, and the screen leaves it out.
      const u = rec.bb ? 'bb' : 'chips';
      s.allInUnit = s.allInUnit && s.allInUnit !== u ? 'mixed' : u;
    }
  }
}

// ---------------------------------------------------------------- what a hand showed
// The only kind of judgement the portal is in a position to make about a decision: whether the
// price was there. It knows what everybody held and what the board did, so when somebody called
// it can work out exactly what he needed and exactly what he had. That is not a solver's opinion
// of how often he should be calling - it is arithmetic about the hand that was actually played,
// and it is either right or it is wrong.
//
// Nothing here guesses. Where the cards are not known the finding is simply not made.
const STREET_CARDS = { preflop: 0, flop: 3, turn: 4, river: 5 };

// A figure inside a sentence, in big blinds where the stakes are known. Chips only mean something
// to somebody who remembers what the table was playing for that night; big blinds mean the same
// thing on every table there has ever been.
function money(n, big) {
  if (!big) return Math.round(n || 0).toLocaleString('en-IN');
  const v = (n || 0) / big;
  return (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + 'bb';
}

// Who had the button, by player id, worked out from who posted the small blind: the seat before
// him, or heads up the small blind himself. The record does not name the button, and everything
// about position hangs off it.
function buttonOf(rec) {
  const players = rec.players || [];
  if (!players.length) return null;
  const sb = (rec.acts || []).find((a) => a.k === 'sb');
  if (!sb) return players[0].id;
  const i = players.findIndex((p) => p.id === sb.id);
  if (i < 0) return players[0].id;
  if (players.length === 2) return sb.id;
  return players[(i - 1 + players.length) % players.length].id;
}

// Every call anybody made on the river, with the price it was made at and whether it was good.
//
// One of these on its own says nothing. The portal knows what the other man held, so on the
// river a call was either winning or it was not, and "you were good 0 times in 100" is only a
// long way of saying "you lost" - a perfectly sound call against somebody who is usually
// bluffing there reads as a blunder. Added up over nights they do say something: how many he
// called, how many were good, and how many needed to be at the prices he was paying.
function riverCalls(rec) {
  const out = [];
  const hole = rec.hole || {};
  const board = rec.board || [];
  if (board.length < 5) return out;
  const live = new Set((rec.players || []).map((p) => p.id));
  const inStreet = {};
  let street = 'preflop', high = 0, pot = 0;
  for (const a of rec.acts || []) {
    if (a.s !== street) { street = a.s; high = 0; for (const k of Object.keys(inStreet)) delete inStreet[k]; }
    if (a.k === 'fold') { live.delete(a.id); continue; }
    if (a.k === 'check') continue;
    const had = inStreet[a.id] || 0;
    const put = a.a - had;
    const blind = a.k === 'sb' || a.k === 'bb' || a.k === 'ante';
    if (!blind && street === 'river' && a.a <= high && put > 0 && hole[a.id] && hole[a.id].length) {
      const others = [...live].filter((x) => x !== a.id && hole[x] && hole[x].length);
      if (others.length && pot > 0) {
        const ids = ['me'].concat(others.map((_, i) => 'o' + i));
        const cs = { me: hole[a.id] };
        others.forEach((x, i) => { cs['o' + i] = hole[x]; });
        const e = equities(board, cs, ids);
        out.push({ id: a.id, put, pot, needed: put / (pot + put), good: e.eq.me });
      }
    }
    inStreet[a.id] = a.a;
    if (a.a > high) high = a.a;
    pot += Math.max(0, put);
  }
  return out;
}

// The one judgement about a single hand that can be made whole: getting it all in. No decision
// follows it, so what the hand was worth at that moment is the entire question, and whether it
// came in or not is beside the point and is said separately. Everything else the portal once
// said hand by hand - a river call that lost, a fold that would have won - was hindsight dressed
// as advice, and has gone into the running tally where it belongs or been dropped.
function findings(rec, forId, big) {
  const out = [];
  const mine = (rec.players || []).filter((p) => (p.memberId || p.id) === forId).map((p) => p.id);
  if (!mine.length) return out;
  const me = mine[0];
  if (rec.allIn && rec.allIn.ids && rec.allIn.ids.length > 1 && rec.allIn.ids.includes(me)) {
    const e = equities(rec.allIn.board || [], rec.allIn.cards || {}, rec.allIn.ids);
    const mineEq = Math.round((e.eq[me] || 0) * 100);
    const took = (rec.won || {})[me] || 0;
    const fair = Math.round((e.eq[me] || 0) * (rec.pot || 0));
    out.push({
      no: rec.no,
      kind: mineEq >= 55 ? 'good' : mineEq >= 40 ? 'fold' : 'call',
      text: 'all in against ' + (rec.allIn.ids.length - 1)
        + (rec.allIn.ids.length === 2 ? ' man' : ' men') + ' with ' + mineEq
        + ' chances in 100. Your share of the ' + money(rec.pot || 0, big) + ' pot was '
        + money(fair, big) + '; you took ' + money(took, big) + '.',
    });
  }
  return out;
}

// Every decision one man made in a hand, with the price he was getting and what he actually
// held at that moment.
//
// This is the thing a solver cannot do and the portal can, because the portal dealt the cards.
// Railbird has to reason about what the others might have; this knows. What it will not do is
// say what they had - a review that listed everybody's folded cards would be a record of how the
// rest of the table plays, handed to one player, and that is not a study tool, it is an edge.
function spots(rec, forId) {
  const hole = rec.hole || {};
  const board = rec.board || [];
  const players = rec.players || [];
  const mine = players.filter((p) => (p.memberId || p.id) === forId).map((p) => p.id);
  if (!mine.length || !hole[mine[0]]) return null;
  const me = mine[0];

  const live = new Set(players.map((p) => p.id));
  const inStreet = {};
  let street = 'preflop';
  let high = 0;
  let pot = 0;
  const steps = [];

  for (const a of rec.acts || []) {
    if (a.s !== street) { street = a.s; high = 0; for (const k of Object.keys(inStreet)) delete inStreet[k]; }
    const had = inStreet[a.id] || 0;

    if (a.id === me && a.k !== 'sb' && a.k !== 'bb' && a.k !== 'ante') {
      const facing = board.slice(0, STREET_CARDS[street] || 0);
      const others = [...live].filter((x) => x !== me && hole[x] && hole[x].length);
      const toCall = Math.max(0, high - had);
      let eq = null;
      if (others.length) {
        const ids = ['me'].concat(others.map((_, i) => 'o' + i));
        const cs = { me: hole[me] };
        others.forEach((x, i) => { cs['o' + i] = hole[x]; });
        eq = equities(facing, cs, ids).eq.me;
      }
      steps.push({
        street,
        did: a.k === 'allin' ? (a.a > high ? 'raise' : 'call') : a.k,
        amount: a.a,
        pot: Math.round(pot),
        toCall: Math.round(toCall),
        needed: toCall > 0 ? Math.round((toCall / (pot + toCall)) * 100) : null,
        equity: eq === null ? null : Math.round(eq * 100),
        against: others.length,
      });
    }

    if (a.k === 'fold') { live.delete(a.id); continue; }
    if (a.k === 'check') continue;
    inStreet[a.id] = a.a;
    if (a.a > high) high = a.a;
    pot += a.a - had;
  }

  return {
    no: rec.no, pot: rec.pot, board,
    cards: hole[me],
    // what everybody else held is deliberately not here
    won: (rec.won || {})[me] || 0,
    steps,
  };
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
      sawFlop: s.sawFlop,
      wonAtShowdown: pct(s.wonAtShowdown, s.showdowns),
      // bets and raises against calls. One means he raises as often as he calls.
      aggression: s.passive ? Math.round((s.aggressive / s.passive) * 100) / 100 : (s.aggressive ? null : 0),
      allIns: s.allIns,
      // what the pots he was all-in for were worth to him, against what he actually took
      dueAllIn: Math.round(s.allInEquity),
      gotAllIn: Math.round(s.allInWon),
      luck: Math.round(s.allInWon - s.allInEquity),
      luckUnit: s.allInUnit || 'chips',
      // calls on the river: how many, how many were good, how many had to be at those prices
      riverCalls: s.riverCalls,
      riverGood: Math.round(s.riverGood * 10) / 10,
      riverNeeded: Math.round(s.riverNeeded * 10) / 10,
      pos: ['btn', 'blind', 'other'].reduce((o, k) => {
        const q = s.pos[k];
        o[k] = { hands: q.hands, vpip: pct(q.vpip, q.hands), pfr: pct(q.pfr, q.hands) };
        return o;
      }, {}),
      sampled: s.sampled,
    };
  }
  return out;
}

// Plain observations, and nothing more than that. Each one is a thing the portal counted, said
// back in words, with the count attached so it can be checked. None of them is advice: the portal
// has no idea what the right frequency is, and a number dressed up as a verdict would be a lie
// told confidently.
// `who` decides the voice: the night's own review is addressed to the man reading it, while the
// screen that lists everybody has to talk about each of them by name.
function remarks(r, big, who) {
  const you = who === 'you';
  const HE = you ? 'you' : 'he';
  const HIM = you ? 'you' : 'him';
  const out = [];
  if (!r || !r.hands || r.hands < 20) return out;
  const n = r.hands;
  const inTen = (p) => Math.max(1, Math.round(p / 10));
  if (r.foldToCbet !== null && r.foldToCbet >= 70) {
    out.push(`when somebody bet the flop at ${HIM}, ${HE} folded about ${inTen(r.foldToCbet)} ${inTen(r.foldToCbet) === 1 ? 'time' : 'times'} in 10`);
  }
  if (r.foldTo3Bet !== null && r.foldTo3Bet >= 75) {
    out.push(`when ${HE} raised and somebody raised ${HIM} back, ${HE} gave it up about ${inTen(r.foldTo3Bet)} ${inTen(r.foldTo3Bet) === 1 ? 'time' : 'times'} in 10`);
  }
  if (r.cbet !== null && r.cbetChance !== 0 && r.cbet <= 25) {
    out.push(`after raising before the flop ${HE} bet the flop only ${r.cbet === 0 ? 'once all night, or not at all' : 'about ' + inTen(r.cbet) + (inTen(r.cbet) === 1 ? ' time' : ' times') + ' in 10'}`);
  }
  if (r.allIns >= 5 && Math.abs(r.luck) > 0 && r.luckUnit !== 'mixed') {
    const u = r.luckUnit === 'bb' ? 'bb' : ' chips';
    out.push(r.luck < 0
      ? `${you ? 'your' : 'his'} all-ins were worth ${Math.abs(r.luck).toLocaleString('en-IN')}${u} more than ${HE} actually took - the cards owed ${HIM}`
      : `${HE} took ${r.luck.toLocaleString('en-IN')}${u} more from ${you ? 'your' : 'his'} all-ins than they were worth - the cards were kind`);
  }
  void big;
  void n;
  return out;
}

module.exports = { equities, money, buttonOf, riverCalls, report, remarks, readHand, expand, findings, spots, STUDY_KINDS, STUDY_STREETS };
