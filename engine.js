'use strict';
// Poker engine: deck, hand ranking, and one no-limit Texas Hold'em hand
// (blinds, betting rounds, side pots, showdown). No dependencies.
const crypto = require('crypto');

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const CATEGORY = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

function newDeck() {
  const d = [];
  for (const r of RANKS) for (const s of SUITS) d.push(r + s);
  return d;
}

// Fisher-Yates with cryptographically secure randomness
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const rankVal = (c) => RANKS.indexOf(c[0]);

// Score exactly five cards. Higher number = better hand.
function score5(cards) {
  const vals = cards.map(rankVal).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const counts = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  const groups = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a] || b - a);
  const shape = groups.map((g) => counts[g]).join('');
  let straightHigh = -1;
  if (groups.length === 5) {
    if (vals[0] - vals[4] === 4) straightHigh = vals[0];
    else if (vals[0] === 12 && vals[1] === 3) straightHigh = 3; // A-2-3-4-5
  }
  let cat, tb;
  if (straightHigh >= 0 && flush) { cat = 8; tb = [straightHigh]; }
  else if (shape === '41') { cat = 7; tb = groups; }
  else if (shape === '32') { cat = 6; tb = groups; }
  else if (flush) { cat = 5; tb = vals; }
  else if (straightHigh >= 0) { cat = 4; tb = [straightHigh]; }
  else if (shape === '311') { cat = 3; tb = groups; }
  else if (shape === '221') { cat = 2; tb = groups; }
  else if (shape === '2111') { cat = 1; tb = groups; }
  else { cat = 0; tb = vals; }
  let s = cat;
  for (let i = 0; i < 5; i++) s = s * 13 + (tb[i] || 0);
  return s;
}

// Best five of any 5-7 cards (Hold'em rule)
function bestScore(cards) {
  let best = -1;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const s = score5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (s > best) best = s;
          }
  return best;
}

const categoryOf = (score) => CATEGORY[Math.floor(score / 13 ** 5)];

class Hand {
  // players: [{id, seat, stack}] in seat order, only players dealt in.
  // buttonIdx: index in that array.
  constructor({ players, buttonIdx, sb, bb, ante = 0 }) {
    if (players.length < 2) throw new Error('need at least 2 players');
    this.sb = sb; this.bb = bb; this.ante = ante;
    this.players = players.map((p) => ({
      id: p.id, seat: p.seat, stack: p.stack, bet: 0, invested: 0,
      folded: false, allIn: false, cards: [], acted: false, canRaise: true,
    }));
    this.n = this.players.length;
    this.buttonIdx = buttonIdx;
    this.deck = shuffle(newDeck());
    this.board = [];
    this.street = 'preflop';
    this.finished = false;
    this.result = null;
    this.currentBet = 0;
    this.minRaise = bb;
    this.turn = -1;
    this.log = [];

    if (ante > 0) for (const p of this.players) {
      const a = Math.min(ante, p.stack);
      p.stack -= a; p.invested += a;
      if (p.stack === 0) p.allIn = true;
    }
    const headsUp = this.n === 2;
    this.sbIdx = headsUp ? buttonIdx : (buttonIdx + 1) % this.n;
    this.bbIdx = headsUp ? (buttonIdx + 1) % this.n : (buttonIdx + 2) % this.n;
    this.postBet(this.sbIdx, sb);
    this.postBet(this.bbIdx, bb);
    for (let r = 0; r < 2; r++)
      for (let i = 0; i < this.n; i++) this.players[(this.sbIdx + i) % this.n].cards.push(this.deck.pop());

    const first = headsUp ? this.sbIdx : (this.bbIdx + 1) % this.n;
    this.turn = this.nextActor(first - 1, true);
    if (this.turn < 0 || this.roundDone()) this.advance();
  }

  postBet(idx, amount) {
    const p = this.players[idx];
    const amt = Math.min(amount, p.stack);
    p.stack -= amt; p.bet += amt; p.invested += amt;
    if (p.stack === 0) p.allIn = true;
    if (p.bet > this.currentBet) this.currentBet = p.bet;
  }

  live() { return this.players.filter((p) => !p.folded); }
  canAct() { return this.players.filter((p) => !p.folded && !p.allIn); }

  // next player after idx who still owes an action (or any active one when `any`)
  nextActor(idx, any = false) {
    for (let k = 1; k <= this.n; k++) {
      const i = (((idx + k) % this.n) + this.n) % this.n;
      const p = this.players[i];
      if (p.folded || p.allIn) continue;
      if (any || !p.acted || p.bet < this.currentBet) return i;
    }
    return -1;
  }

  roundDone() {
    const ca = this.canAct();
    if (ca.length === 0) return true;
    if (ca.length === 1 && ca[0].bet >= this.currentBet) return true;
    return ca.every((p) => p.acted && p.bet === this.currentBet);
  }

  get turnId() { return this.turn >= 0 && !this.finished ? this.players[this.turn].id : null; }
  get pot() { return this.players.reduce((s, p) => s + p.invested, 0); }

  legal(id) {
    if (this.finished || this.turnId !== id) return null;
    const p = this.players[this.turn];
    const maxTo = p.bet + p.stack;
    const toCall = Math.min(this.currentBet - p.bet, p.stack);
    const canRaise = p.canRaise && maxTo > this.currentBet;
    const minTo = Math.min(this.currentBet + this.minRaise, maxTo);
    return {
      toCall, canCheck: this.currentBet === p.bet, canRaise,
      minRaiseTo: minTo, maxRaiseTo: maxTo, currentBet: this.currentBet,
      myBet: p.bet, stack: p.stack, pot: this.pot,
    };
  }

  act(id, type, amount) {
    if (this.finished) throw new Error('hand is over');
    const L = this.legal(id);
    if (!L) throw new Error('not your turn');
    const p = this.players[this.turn];
    if (type === 'fold') {
      p.folded = true; this.log.push(`${id} folds`);
    } else if (type === 'check') {
      if (!L.canCheck) throw new Error('cannot check');
      p.acted = true;
    } else if (type === 'call') {
      if (L.toCall <= 0) throw new Error('nothing to call');
      this.postBet(this.turn, L.toCall);
      p.acted = true;
    } else if (type === 'raise') {
      amount = Math.floor(Number(amount));
      if (!L.canRaise) throw new Error('cannot raise');
      if (!(amount > this.currentBet)) throw new Error('raise must be above the current bet');
      if (amount > L.maxRaiseTo) throw new Error('not enough chips');
      if (amount < L.minRaiseTo) throw new Error('raise is below the minimum');
      const raiseSize = amount - this.currentBet;
      const full = raiseSize >= this.minRaise;
      this.postBet(this.turn, amount - p.bet);
      p.acted = true;
      if (full) this.minRaise = raiseSize;
      for (const o of this.players) {
        if (o === p || o.folded || o.allIn) continue;
        const was = o.acted;
        o.acted = false;
        if (full) o.canRaise = true;
        else if (was) o.canRaise = false;
      }
    } else throw new Error('unknown action');
    this.afterAction();
  }

  // Fold if facing a bet, otherwise check (used for turn timeouts)
  autoAction() {
    const id = this.turnId;
    const L = this.legal(id);
    return { id, type: L && L.canCheck ? 'check' : 'fold' };
  }

  afterAction() {
    if (this.live().length === 1) return this.finishUncontested();
    if (this.roundDone()) return this.advance();
    this.turn = this.nextActor(this.turn);
  }

  advance() {
    while (!this.finished) {
      if (this.live().length === 1) return this.finishUncontested();
      for (const p of this.players) { p.bet = 0; p.acted = false; p.canRaise = true; }
      this.currentBet = 0; this.minRaise = this.bb;
      if (this.street === 'river') return this.showdown();
      this.deck.pop(); // burn
      if (this.street === 'preflop') { this.street = 'flop'; this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop()); }
      else if (this.street === 'flop') { this.street = 'turn'; this.board.push(this.deck.pop()); }
      else { this.street = 'river'; this.board.push(this.deck.pop()); }
      if (this.canAct().length > 1) {
        this.turn = this.nextActor(this.buttonIdx, true);
        return;
      }
      // nobody can bet any more: deal the rest of the board
    }
  }

  buildPots() {
    const live = this.live();
    const levels = [...new Set(live.map((p) => p.invested))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lvl of levels) {
      let amount = 0;
      for (const p of this.players) amount += Math.max(0, Math.min(p.invested, lvl) - prev);
      const eligible = live.filter((p) => p.invested >= lvl).map((p) => p.id);
      if (amount > 0) {
        const last = pots[pots.length - 1];
        if (last && last.eligible.join() === eligible.join()) last.amount += amount;
        else pots.push({ amount, eligible });
      }
      prev = lvl;
    }
    return pots;
  }

  finishUncontested() {
    const w = this.live()[0];
    const total = this.pot;
    w.stack += total;
    this.finished = true; this.turn = -1;
    this.result = {
      uncontested: true, reveal: {}, won: { [w.id]: total },
      pots: [{ amount: total, eligible: [w.id], winners: [{ id: w.id, share: total }] }],
    };
  }

  showdown() {
    this.street = 'showdown';
    const scores = {};
    const reveal = {};
    for (const p of this.live()) {
      scores[p.id] = bestScore(p.cards.concat(this.board));
      reveal[p.id] = { cards: p.cards.slice(), handName: categoryOf(scores[p.id]) };
    }
    const won = {};
    const pots = this.buildPots().map((pot) => {
      let best = -1;
      for (const id of pot.eligible) best = Math.max(best, scores[id]);
      let winners = pot.eligible.filter((id) => scores[id] === best);
      // odd chips go to the winners closest to the left of the button
      winners.sort((a, b) => this.dist(a) - this.dist(b));
      const base = Math.floor(pot.amount / winners.length);
      let extra = pot.amount - base * winners.length;
      const out = winners.map((id) => {
        const share = base + (extra-- > 0 ? 1 : 0);
        won[id] = (won[id] || 0) + share;
        return { id, share };
      });
      return { amount: pot.amount, eligible: pot.eligible, winners: out };
    });
    for (const p of this.players) if (won[p.id]) p.stack += won[p.id];
    this.finished = true; this.turn = -1;
    this.result = { uncontested: false, reveal, won, pots };
  }

  dist(id) {
    const i = this.players.findIndex((p) => p.id === id);
    return (i - this.buttonIdx - 1 + this.n * 2) % this.n;
  }

  // What one viewer is allowed to see
  view(viewerId) {
    const showAll = this.result && !this.result.uncontested;
    const L = viewerId ? this.legal(viewerId) : null;
    return {
      street: this.street,
      board: this.board.slice(),
      pot: this.pot,
      currentBet: this.currentBet,
      turnId: this.turnId,
      finished: this.finished,
      legal: L,
      players: this.players.map((p) => ({
        id: p.id, seat: p.seat, stack: p.stack, bet: p.bet, invested: p.invested,
        folded: p.folded, allIn: p.allIn,
        isButton: this.players[this.buttonIdx] === p,
        cards: p.id === viewerId ? p.cards.slice()
          : (showAll && !p.folded ? p.cards.slice() : (p.folded ? null : ['??', '??'])),
      })),
    };
  }
}

module.exports = { Hand, newDeck, shuffle, score5, bestScore, categoryOf, RANKS, SUITS };
