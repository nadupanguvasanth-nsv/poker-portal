'use strict';
// Copyright (c) 2026 Vashanth Somasundaram. All rights reserved. See LICENSE.
// A table: who is sitting at it, whose turn it is, which game this hand is, and the money.
//
// Four formats:
//   holdem      Texas hold'em, every hand.
//   mixed       Texas, and one hand of the chosen variant at the end of each orbit of the button.
//               That hand is dealt from a button of its own, which starts at the seat before the
//               Texas button and walks the other way round, one seat each orbit.
//   roe         Round of each: an orbit of Texas, then an orbit of the variant, and so on.
//   tournament  Everybody starts with the same chips, blinds double every five minutes, nobody
//               joins late and nobody buys more. It ends when one player holds the lot.

const { Hand, VARIANTS } = require('./engine');
const crypto = require('crypto');

const rid = (n = 6) => crypto.randomBytes(16).toString('base64url').replace(/[-_]/g, '').slice(0, n);
const CODE = () => crypto.randomBytes(8).toString('base64url').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 4) || 'TBL1';

const SEATS = Number(process.env.SEATS || 7);          // a seven-handed table, first come first served
const FORMATS = {
  holdem: { name: "Texas Hold'em", needsVariant: false },
  mixed: { name: "Hold'em with a variant each orbit", needsVariant: true },
  roe: { name: 'Round of each', needsVariant: true },
  tournament: { name: 'Tournament', needsVariant: false },
};
// the variants a member may pick for mixed and round-of-each
const PICKABLE = ['omaha4', 'omaha5', 'bomb2', 'bomb5', 'bomb5x3'];

const TOURNEY = {
  stack: Number(process.env.TOURNEY_STACK || 10000),
  levelMs: Number(process.env.TOURNEY_LEVEL_MS || 5 * 60000),  // blinds double at every level
  step: 10000,            // the chips are set in tens of thousands, nothing in between
  minStack: 10000,
  maxStack: 10000000,
  minLevelMin: 2,
  maxLevelMin: 60,
};

// Whoever runs a tournament picks the chips everyone starts with, in tens of thousands, and the
// blinds follow from it: everybody begins two hundred big blinds deep. Because the stack is always
// a multiple of ten thousand the arithmetic comes out whole and round every time - 10,000 opens at
// 25/50, 100,000 at 250/500 - so there is nothing to round and nothing to approximate.
function tourneyStack(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return TOURNEY.stack;
  const snapped = Math.round(n / TOURNEY.step) * TOURNEY.step;
  return Math.min(TOURNEY.maxStack, Math.max(TOURNEY.minStack, snapped));
}
function tourneyBlinds(stack) {
  return { sb: stack / 400, bb: stack / 200 };
}

// Nobody is capped by default. A ceiling the person opening the table never chose is worse than
// no ceiling at all: it sits there invisibly until somebody is refused by it. Whoever wants one
// can still set maxBuyin, and a tournament sets its own.
const NO_CAP = 1e9;
const DEFAULTS = {
  sb: 100, bb: 200, minBuyin: 10000, maxBuyin: NO_CAP,
  minPlayers: 4, turnSeconds: 40, bombAnteBB: 5, minMinutes: 0,
};

function cleanSettings(s = {}, old = DEFAULTS) {
  const num = (v, min, max, dflt) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
  };
  const sb = num(s.sb, 1, 1e7, old.sb);
  const bb = num(s.bb, sb, 1e7, Math.max(sb, old.bb));
  const minBuyin = num(s.minBuyin, bb, 1e9, old.minBuyin);
  return {
    sb, bb, minBuyin,
    maxBuyin: num(s.maxBuyin, minBuyin, 1e9, Math.max(minBuyin, old.maxBuyin)),
    minPlayers: num(s.minPlayers, 2, SEATS, old.minPlayers),
    turnSeconds: num(s.turnSeconds, 10, 300, old.turnSeconds),
    // how long somebody is expected to stay once they sit down; 0 means they may go when they like
    minMinutes: num(s.minMinutes, 0, 600, old.minMinutes || 0),
    bombAnteBB: num(s.bombAnteBB, 0, 50, old.bombAnteBB),
  };
}

// A tournament settles its own blinds and buy-in from the chips everyone starts with, so only the
// stack, the level length and the ordinary table settings come from whoever opens it.
function tourneySettings(s = {}) {
  const base = cleanSettings(s);
  const stack = tourneyStack(s.stack);
  const m = Math.floor(Number(s.levelMin));
  const levelMin = Number.isFinite(m) && m >= TOURNEY.minLevelMin && m <= TOURNEY.maxLevelMin
    ? m : Math.round(TOURNEY.levelMs / 60000);
  const b = tourneyBlinds(stack);
  return { ...base, minPlayers: 2, sb: b.sb, bb: b.bb, minBuyin: stack, maxBuyin: stack, levelMs: levelMin * 60000 };
}

class Table {
  constructor({ format, variant, admin, settings, title }) {
    if (!FORMATS[format]) throw new Error('Pick a game');
    if (FORMATS[format].needsVariant && !PICKABLE.includes(variant)) throw new Error('Pick the variant to go with it');
    this.code = CODE();
    this.format = format;
    this.variant = FORMATS[format].needsVariant ? variant : null;
    this.adminId = admin.id;                 // the member who started it runs it
    this.adminName = admin.name;
    this.title = title || '';
    this.createdAt = Date.now();
    this.startedAt = 0;
    this.endedAt = 0;
    this.status = 'waiting';                 // waiting -> playing -> ended
    this.settings = format === 'tournament' ? tourneySettings(settings) : cleanSettings(settings);
    this.seats = Array(SEATS).fill(null);    // seat -> player id
    this.players = new Map();
    this.hand = null;
    this.handNo = 0;
    this.button = -1;                        // seat of the Texas button
    this.varButton = -1;                     // seat of the variant button, walking the other way
    this.orbitSeen = [];                     // seats that have dealt this orbit
    this.roeVariant = false;                 // roe: this orbit is the variant orbit
    this.level = 1;                          // tournament blind level
    this.levelAt = 0;
    this.requests = [];                      // members asking to be let in
    this.log = [];
    this.rounds = [];                        // the best hands, kept for replay
    this.notes = [];                         // messages to the game admin
    this.fx = [];
  }

  // ---- seats ----
  freeSeats() { return this.seats.filter((s) => !s).length; }
  at(seat) { return this.seats[seat] ? this.players.get(this.seats[seat]) : null; }
  list() { return [...this.players.values()]; }
  live() { return this.list().filter((p) => !p.out && p.stack > 0); }
  seated() { return this.list().filter((p) => !p.out); }
  isAdmin(memberId) { return this.adminId === memberId; }
  byMember(memberId) { return this.list().find((p) => p.memberId === memberId) || null; }

  sit(member) {
    const already = this.byMember(member.id);
    if (already) { already.out = false; return already; }
    const seat = this.seats.findIndex((s) => !s);
    if (seat < 0) throw new Error('The table is full');
    const p = {
      id: rid(6), memberId: member.id, name: member.nick || member.name, seat,
      stack: 0, bought: 0, ledger: [], away: false, out: false,
      joinedAt: Date.now(), leaveAsk: 0, leaveOk: false, busted: 0,
    };
    this.players.set(p.id, p);
    this.seats[seat] = p.id;
    this.say(`${p.name} sat down`);
    if (this.format === 'tournament') this.give(p, this.settings.minBuyin, 'stack');
    return p;
  }
  stand(p, why) {
    if (!p) return;
    p.out = true;
    this.seats[p.seat] = null;
    this.say(`${p.name} left${why ? ' (' + why + ')' : ''}`);
  }

  // Whether somebody has stayed as long as they said they would. A player who has lost everything
  // has nothing left to stay for, so his time is up whatever the clock says.
  //
  // The time is there to stop somebody winning a pot and walking out with it. It was never meant
  // to keep a man at the table losing: so it binds only a player who is ahead. Anybody with no
  // more in front of him than he has bought in for is free to go whenever he likes, without
  // asking and without his blinds being taken.
  ahead(p) { return !!p && p.stack > (p.bought || 0); }
  servedTime(p) {
    if (!p) return true;
    if (p.stack <= 0) return true;
    if (!this.ahead(p)) return true;
    const mins = this.settings.minMinutes || 0;
    if (!mins) return true;
    return Date.now() - (p.joinedAt || this.createdAt) >= mins * 60000;
  }
  // Somebody who asked to leave early and was told no: he stays in the ring paying his blinds
  // until his time is up, but he is not dealt a hand.
  isForfeiting(p) { return !!(p && p.forfeit && !this.servedTime(p)); }

  give(p, amount, kind = 'buyin') {
    p.stack += amount;
    p.bought += amount;
    p.ledger.push({ kind, amount, at: Date.now() });
  }

  say(text) {
    this.log.push({ at: Date.now(), text });
    if (this.log.length > 300) this.log.shift();
  }

  // ---- which game is this hand ----
  // The orbit bookkeeping lives here so the rules of each format are in one readable place.
  // In a mixed game the variant button marks a seat, not a dealer. The button travels as it
  // always does; when it lands on the seat the variant button is sitting on, that player deals the
  // variant instead of Texas, and only then does the variant button step back one seat.
  variantForHand() {
    if (this.format === 'holdem' || this.format === 'tournament') return 'holdem';
    if (this.format === 'mixed') return this.button === this.varButton ? this.variant : 'holdem';
    return this.roeVariant ? this.variant : 'holdem';     // roe
  }
  buttonForHand() { return this.button; }   // one button deals, always

  occupied() { return this.seats.map((id, i) => (id && !this.players.get(id).out ? i : -1)).filter((i) => i >= 0); }
  // The seats the button can travel through: the ones that will actually be dealt a hand.
  //
  // It used to travel through every seat somebody was sitting in, including a player who was
  // sitting out, had no chips, or had dropped off. The button would land on him, nobody could
  // deal from there, and the hand fell to the next player along - who had just had the button.
  // Heads up with a third man sitting out, one player posted the small blind two hands in every
  // three. A seat that is not being dealt in is passed over, as it would be at a real table.
  dealSeats() {
    const live = this.seated()
      .filter((p) => p.stack > 0 && (this.format === 'tournament' || (!p.away && !p.dropped)))
      .map((p) => p.seat).sort((a, b) => a - b);
    return live.length >= 2 ? live : this.occupied();
  }
  nextSeat(from, back = false) {
    const seats = this.dealSeats();
    if (!seats.length) return -1;
    if (from < 0) return seats[0];
    const ordered = back ? [...seats].reverse() : seats;
    const after = ordered.find((s) => (back ? s < from : s > from));
    return after === undefined ? ordered[0] : after;
  }

  // Called once a hand is over, to set up the next one.
  advance() {
    const seats = this.occupied();
    if (seats.length < 2) return;
    if (this.format === 'mixed') {
      // The seat holding the variant button can empty - that player busts or walks off - and then
      // the travelling button can never land on it, so the variant would stop coming round for the
      // rest of the night. Put it on a seat somebody is actually sitting in.
      if (this.varButton < 0 || !this.dealSeats().includes(this.varButton)) this.varButton = this.nextSeat(this.varButton, true);
      // the hand just played was the variant one, so the variant button steps back the other way
      if (this.button === this.varButton) this.varButton = this.nextSeat(this.varButton, true);
    }
    // An orbit is everybody at the table dealing once. Keep the seats that have dealt rather than
    // waiting for the button to come back to one particular seat: that seat can bust or walk off
    // mid-orbit, the button never lands there again, and the game quietly stays on one variant for
    // the rest of the night.
    if (this.format === 'roe' && this.button >= 0) {
      this.orbitSeen = (this.orbitSeen || []).filter((s) => this.seats[s]);
      // the seat the hand was actually dealt from, which is not always where the button was left
      const dealtFrom = this.dealSeats().includes(this.button) ? this.button : this.nextSeat(this.button);
      if (!this.orbitSeen.includes(dealtFrom)) this.orbitSeen.push(dealtFrom);
    }
    this.button = this.nextSeat(this.button);
    if (this.format !== 'roe') return;
    if (!this.dealSeats().every((s) => this.orbitSeen.includes(s))) return;   // still going round
    this.roeVariant = !this.roeVariant;          // round of each: turn and turn about
    this.orbitSeen = [];
  }

  // ---- blinds, which climb in a tournament ----
  blinds() {
    if (this.format !== 'tournament') return { sb: this.settings.sb, bb: this.settings.bb };
    const mult = Math.pow(2, this.level - 1);
    return { sb: this.settings.sb * mult, bb: this.settings.bb * mult };
  }
  // A table stored before the level length could be set has no levelMs of its own.
  levelMs() { return Number(this.settings.levelMs) || TOURNEY.levelMs; }
  // Returns true if the level went up, so the table can be told.
  tickLevel() {
    if (this.format !== 'tournament' || this.status !== 'playing') return false;
    if (this.paused) return false;               // the clock stands still with the game
    if (!this.levelAt || Date.now() < this.levelAt) return false;
    this.level += 1;
    this.levelAt = Date.now() + this.levelMs();
    const b = this.blinds();
    this.say(`Blinds up: ${b.sb}/${b.bb}`);
    return true;
  }

  // Who is actually ready to be dealt in: chips in front of them and not sitting out. Four people
  // where one has stepped away is a three-handed game, and should not set a table going.
  // In a tournament there is no sitting out, so everybody with chips counts.
  // Nor is anybody whose phone has dropped out: he is held out of the deal until it is back.
  ready() { return this.seated().filter((p) => p.stack > 0 && (this.format === 'tournament' || (!p.away && !p.dropped))); }

  canStart() {
    if (this.status === 'ended') return 'This game has ended';
    const ready = this.ready();
    // How many it takes to BEGIN is not how many it takes to carry on. The table's number is for
    // getting a game going and for nothing after that: once the first hand has been dealt, any
    // game goes on for as long as two people have chips. Held to its starting number, a table of
    // four stopped dead the moment one man went out, stood up or let his clock run down - and a
    // tournament stopped for good, because nobody can join one to make the number up again.
    // A tournament has no starting number at all. Nothing about it is automatic: whoever runs it
    // looks at who has turned up and starts it when he judges that enough, and the only thing
    // the table insists on is the two it takes to play a hand.
    const need = this.startedAt || this.format === 'tournament' ? 2 : Math.max(2, this.settings.minPlayers);
    if (ready.length < need) {
      return `Waiting for ${need} players with chips (${ready.length} so far)`;
    }
    return '';
  }

  deal() {
    const why = this.canStart();
    if (why) throw new Error(why);
    const dealt = this.seated()
      .filter((p) => p.stack > 0 && (this.format === 'tournament' || (!p.away && !p.dropped)))
      .sort((a, b) => a.seat - b.seat);
    if (dealt.length < 2) throw new Error('Not enough players with chips');

    if (this.button < 0) {                      // the very first hand sets both buttons going
      this.button = dealt[0].seat;
      this.orbitSeen = [];
      this.varButton = this.nextSeat(this.button, true);   // the variant button starts one behind
    }
    const variant = this.variantForHand();
    const spec = VARIANTS[variant];
    const playing = dealt.length > spec.max ? dealt.slice(0, spec.max) : dealt;
    if (dealt.length > spec.max) this.say(`${spec.name} seats ${spec.max}, so this hand is ${spec.max}-handed`);

    const btnSeat = this.buttonForHand();
    let buttonIdx = playing.findIndex((p) => p.seat === btnSeat);
    if (buttonIdx < 0) {                        // the button sits in an empty seat: take the next one along
      const after = playing.find((p) => p.seat > btnSeat);
      buttonIdx = after ? playing.indexOf(after) : 0;
    }
    const b = this.blinds();
    const bombAnte = spec.bomb ? b.bb * this.settings.bombAnteBB : 0;
    this.hand = new Hand({
      players: playing.map((p) => ({ id: p.id, seat: p.seat, stack: p.stack, ghost: this.isForfeiting(p) })),
      buttonIdx, sb: b.sb, bb: b.bb, variant, bombAnte,
      runItMin: this.format === 'tournament' ? 0 : this.settings.minBuyin,
    });
    this.handNo += 1;
    this.status = 'playing';
    if (!this.startedAt) {
      this.startedAt = Date.now();
      if (this.format === 'tournament') this.levelAt = Date.now() + this.levelMs();
    }
    this.say(`Hand ${this.handNo}: ${spec.name}${variant !== 'holdem' ? ' (variant hand)' : ''}`);
    return this.hand;
  }

  // Move the chips a finished hand decided, and knock out anybody with nothing left.
  settle() {
    const h = this.hand;
    if (!h || !h.finished) return;
    for (const hp of h.players) {
      const p = this.players.get(hp.id);
      if (p) p.stack = hp.stack;
    }
    if (this.format === 'tournament') {
      for (const p of this.seated()) {
        if (p.stack > 0 || p.busted) continue;
        p.busted = Date.now();
        p.place = this.seated().filter((x) => x.busted || x.stack > 0).length;
        this.say(`${p.name} is out`);
      }
    }
    this.advance();
  }

  // A tournament is over when one player holds every chip.
  tourneyWinner() {
    if (this.format !== 'tournament') return null;
    const alive = this.seated().filter((p) => p.stack > 0);
    return alive.length === 1 ? alive[0] : null;
  }
}

module.exports = { Table, FORMATS, PICKABLE, VARIANTS, SEATS, TOURNEY, NO_CAP, tourneyBlinds, tourneyStack, tourneySettings, DEFAULTS, cleanSettings, rid };
