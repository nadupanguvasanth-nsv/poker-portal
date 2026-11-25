'use strict';
// Writing a night out the way an online room writes it, so a tool built to read those can read
// this one.
//
// PokerStars' text format is the one every poker tool understands, so that is what this imitates
// - not to pretend to be PokerStars, but because a format nothing can read is no use to anybody.
// It is picky: the headings, the seat lines, the street markers and the summary are all matched
// on, and a line out of place means the hand is skipped with no explanation. So this follows the
// shape exactly, and what the portal does not have (rake, a real hand number) is written as the
// honest equivalent rather than left out.
//
// Only Texas hands can be written. Three flops and five-card Omaha have no expression in this
// format at all - there is nowhere to put a second board - and a tool that reads them would be
// reading something that is not what happened.

const RANK = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', T: 'T', J: 'J', Q: 'Q', K: 'K', A: 'A' };

// The portal writes a card as 'As'; so does PokerStars. The suits are the same letters.
const card = (c) => (c && RANK[c[0]] ? c[0] + c[1] : '');
const cards = (list) => (list || []).map(card).filter(Boolean).join(' ');

// Chips are chips. The format wants an amount, and writing them as whole chips keeps every
// figure exactly what it was at the table rather than inventing a currency nobody played for.
const amt = (n) => String(Math.round(n || 0));

// PokerStars writes a time and then a zone, and a reader that only knows the zones PokerStars
// uses will throw out anything else - so the time is genuinely converted to Eastern and labelled
// ET rather than an Indian time wearing an American label. Both lines are written, which is what
// PokerStars itself does, so a reader can take whichever it understands.
function stamp(at) {
  const d = new Date(at || Date.now());
  const parts = (zone) => new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const et = parts('America/New_York');
  const utc = parts('UTC');
  return `${et.year}/${et.month}/${et.day} ${et.hour}:${et.minute}:${et.second} ET`
    + ` [${utc.year}/${utc.month}/${utc.day} ${utc.hour}:${utc.minute}:${utc.second} UTC]`;
}

// One hand.
//
// `rec` is what the portal kept: the players with their seats and starting stacks, every action
// in order with the street it happened on, the board, who showed what, and who took what.
function handText(rec, opts) {
  const o = opts || {};
  const sb = o.sb || 0, bb = o.bb || 0;
  const players = rec.players || [];
  if (!players.length) return '';
  const seatOf = {};
  players.forEach((p) => { seatOf[p.id] = p.seat; });
  const nameOf = (id) => {
    const p = players.find((x) => x.id === id);
    return (p && p.name) ? p.name.replace(/\s+/g, '_') : id;
  };

  const acts = rec.acts || [];
  const byStreet = { preflop: [], flop: [], turn: [], river: [] };
  for (const a of acts) if (byStreet[a.s]) byStreet[a.s].push(a);

  // A hand number is a number. PokerStars' are long strings of digits and a reader looks for
  // digits after the hash, so anything with a letter in it fails every hand in the file without
  // saying why. The portal's own code goes in the table name, where it belongs.
  const id = `${String(o.gameNo || 1).replace(/\D/g, '') || '1'}${String(rec.no || 0).padStart(5, '0')}`;
  const table = (o.table || 'Smart Buddies').replace(/\s+/g, ' ');
  const buttonSeat = typeof rec.button === 'number' ? rec.button : (players[0] ? players[0].seat : 0);

  let out = `PokerStars Hand #${id}:  Hold'em No Limit (${amt(sb)}/${amt(bb)}) - ${stamp(rec.at, o.tz)}\n`;
  out += `Table '${table}' ${o.seats || 9}-max Seat #${buttonSeat + 1} is the button\n`;
  for (const p of players) {
    out += `Seat ${p.seat + 1}: ${nameOf(p.id)} (${amt(p.start)} in chips)\n`;
  }

  // the blinds and antes, in the order they were posted
  for (const a of byStreet.preflop) {
    if (a.k === 'ante') out += `${nameOf(a.id)}: posts the ante ${amt(a.a)}\n`;
    else if (a.k === 'sb') out += `${nameOf(a.id)}: posts small blind ${amt(a.a)}\n`;
    else if (a.k === 'bb') out += `${nameOf(a.id)}: posts big blind ${amt(a.a)}\n`;
  }

  out += '*** HOLE CARDS ***\n';
  const want = rec.hero != null ? rec.hero : o.hero;
  const hero = want != null && seatOf[want] !== undefined ? want : null;
  const hole = rec.cards || {};
  if (hero && hole[hero]) out += `Dealt to ${nameOf(hero)} [${cards(hole[hero])}]\n`;

  // How much each player has already put in on this street, so a call can be written as the
  // difference and a raise as "raises X to Y" - which is what the format wants and what every
  // reader of it expects.
  const say = (list) => {
    const inStreet = {};
    let high = 0;
    let text = '';
    for (const a of list) {
      const who = nameOf(a.id);
      if (a.k === 'sb' || a.k === 'bb' || a.k === 'ante') { inStreet[a.id] = a.a; high = Math.max(high, a.a); continue; }
      if (a.k === 'fold') { text += `${who}: folds\n`; continue; }
      if (a.k === 'check') { text += `${who}: checks\n`; continue; }
      const had = inStreet[a.id] || 0;
      const to = a.a;
      const put = to - had;
      inStreet[a.id] = to;
      const allIn = a.k === 'allin';
      if (to > high) {
        if (high === 0) text += `${who}: bets ${amt(put)}${allIn ? ' and is all-in' : ''}\n`;
        else text += `${who}: raises ${amt(to - high)} to ${amt(to)}${allIn ? ' and is all-in' : ''}\n`;
        high = to;
      } else {
        text += `${who}: calls ${amt(put)}${allIn ? ' and is all-in' : ''}\n`;
      }
    }
    return text;
  };

  out += say(byStreet.preflop);

  const board = (rec.boards && rec.boards[0]) || rec.board || [];
  if (byStreet.flop.length || board.length >= 3) {
    out += `*** FLOP *** [${cards(board.slice(0, 3))}]\n`;
    out += say(byStreet.flop);
  }
  if (byStreet.turn.length || board.length >= 4) {
    out += `*** TURN *** [${cards(board.slice(0, 3))}] [${card(board[3])}]\n`;
    out += say(byStreet.turn);
  }
  if (byStreet.river.length || board.length >= 5) {
    out += `*** RIVER *** [${cards(board.slice(0, 4))}] [${card(board[4])}]\n`;
    out += say(byStreet.river);
  }

  const reveal = rec.reveal || {};
  const shown = Object.keys(reveal).filter((k) => reveal[k] && reveal[k].cards);
  const won = rec.won || {};
  if (shown.length) {
    out += '*** SHOW DOWN ***\n';
    for (const sid of shown) {
      out += `${nameOf(sid)}: shows [${cards(reveal[sid].cards)}]`
        + (reveal[sid].handName ? ` (${reveal[sid].handName.toLowerCase()})` : '') + '\n';
    }
  }
  for (const [wid, v] of Object.entries(won)) {
    if (!v) continue;
    out += `${nameOf(wid)} collected ${amt(v)} from pot\n`;
  }

  // The summary. Nothing reads every line of it, but a hand without one looks truncated.
  out += '*** SUMMARY ***\n';
  out += `Total pot ${amt(rec.pot || 0)} | Rake 0\n`;
  if (board.length >= 3) out += `Board [${cards(board)}]\n`;
  for (const p of players) {
    const line = `Seat ${p.seat + 1}: ${nameOf(p.id)}`;
    const w = won[p.id] || 0;
    if (reveal[p.id] && reveal[p.id].cards) {
      out += `${line} showed [${cards(reveal[p.id].cards)}] and ${w ? 'won (' + amt(w) + ')' : 'lost'}\n`;
    } else if (w) {
      out += `${line} collected (${amt(w)})\n`;
    } else {
      out += `${line} folded\n`;
    }
  }
  return out + '\n\n';
}

// A whole night.
function gameText(game, opts) {
  const o = Object.assign({
    sb: game.sb, bb: game.bb,
    // a number for the hands, and the portal's own code in the table name where letters are fine
    gameNo: String(game.at || Date.now()).slice(-7),
    table: ((game.title || 'Smart Buddies') + ' ' + (game.code || '')).trim(),
    seats: 9,
  }, opts || {});
  const hands = (game.hands || []).filter((h) => !h.variant || h.variant === 'holdem');
  // Hand-history files are written on Windows and read as such: the lines end the way PokerStars
  // ends them, not the way this machine would.
  return hands.map((h) => handText(h, o)).join('').replace(/\r?\n/g, '\r\n');
}

module.exports = { handText, gameText };
