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
// the five cards that make up the best hand
function bestFive(cards) {
  let best = -1, pick = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let x = d + 1; x < n; x++) {
            const f = [cards[a], cards[b], cards[c], cards[d], cards[x]];
            const s = score5(f);
            if (s > best) { best = s; pick = f; }
          }
  return pick;
}

const categoryOf = (score) => CATEGORY[Math.floor(score / 13 ** 5)];

// ---- game variants ----
// hole: cards dealt to each player; omaha: exactly two hole cards plus three board cards;
// boards: boards dealt (bomb pots with several flops); bomb: everybody antes and play starts on the flop;
// pl: pot-limit betting; max: most players allowed
const VARIANTS = {
  holdem: { name: "Texas Hold'em", hole: 2, omaha: false, boards: 1, bomb: false, pl: false, max: 10 },
  omaha4: { name: '4-card Omaha', hole: 4, omaha: true, boards: 1, bomb: false, pl: true, max: 9 },
  omaha5: { name: '5-card Omaha', hole: 5, omaha: true, boards: 1, bomb: false, pl: true, max: 8 },
  bomb2: { name: '2-card bomb pot', hole: 2, omaha: true, boards: 1, bomb: true, pl: true, max: 10 },
  bomb5: { name: '5-card bomb pot, two flops', hole: 5, omaha: true, boards: 2, bomb: true, pl: true, max: 7 },
  bomb5x3: { name: '5-card bomb pot, three flops', hole: 5, omaha: true, boards: 3, bomb: true, pl: true, max: 7 },
};
// run-it (voting to deal the rest of the board more than once) only for single-board games
const canRunIt = (v) => VARIANTS[v].boards === 1;

// Best hand using exactly two hole cards and three board cards
function bestOmaha(hole, board) {
  let best = -1, pick = null;
  for (let i = 0; i < hole.length - 1; i++) for (let j = i + 1; j < hole.length; j++)
    for (let a = 0; a < board.length - 2; a++) for (let b = a + 1; b < board.length - 1; b++) for (let c = b + 1; c < board.length; c++) {
      const f = [hole[i], hole[j], board[a], board[b], board[c]];
      const sc = score5(f);
      if (sc > best) { best = sc; pick = f; }
    }
  return { score: best, five: pick };
}
function evalHand(variant, hole, board) {
  if (VARIANTS[variant].omaha) return bestOmaha(hole, board);
  // One pass. This used to ask for the score and the cards separately, which walked all twenty-one
  // five-card combinations twice over the same seven cards and threw the first answer away.
  const five = bestFive(hole.concat(board));
  return five ? { score: score5(five), five } : { score: -1, five: null };
}

class Hand {
  // players: [{id, seat, stack}] in seat order, only players dealt in.
  // buttonIdx: index in that array.
  constructor({ players, buttonIdx, sb, bb, ante = 0, variant = 'holdem', bombAnte = 0, runItMin = 0 }) {
    if (!VARIANTS[variant]) throw new Error('unknown game');
    this.v = VARIANTS[variant]; this.variant = variant;
    if (players.filter((p) => !p.ghost).length < 2) throw new Error('need at least 2 players');
    if (players.length > this.v.max) throw new Error('too many players for ' + this.v.name);
    this.sb = sb; this.bb = bb; this.ante = ante; this.runItMin = runItMin;
    this.players = players.map((p) => ({
      id: p.id, seat: p.seat, stack: p.stack, start: p.stack, bet: 0, invested: 0,
      folded: false, allIn: false, cards: [], acted: false, canRaise: true, ghost: !!p.ghost,
    }));
    this.n = this.players.length;
    this.buttonIdx = buttonIdx;
    this.deck = shuffle(newDeck());
    this.boards = Array.from({ length: this.v.boards }, () => []);
    this.boardKind = 'boards';
    this.street = 'preflop';
    this.finished = false;
    this.result = null;
    this.currentBet = 0;
    this.minRaise = bb;
    this.turn = -1;
    this.runit = null; // pending vote on running the board more than once
    this.runitDone = false; // one vote per hand, however it came out
    this.runs = 1;
    this.log = [];
    this.acts = []; // every chip that moves, in order, so a hand can be replayed later

    if (ante > 0) for (const p of this.players) {
      const a = Math.min(ante, p.stack);
      p.stack -= a; p.invested += a;
      this.rec('ante', p.id, a);
      if (p.stack === 0) p.allIn = true;
    }
    if (this.v.bomb) {
      // everybody antes, no blinds, hole cards then the flop(s) straight away, betting starts on the flop
      for (const p of this.players) {
        const a = Math.min(bombAnte, p.stack);
        p.stack -= a; p.invested += a;
        this.rec('ante', p.id, a);
        if (p.stack === 0) p.allIn = true;
      }
      this.sbIdx = -1; this.bbIdx = -1;
      for (let r = 0; r < this.v.hole; r++)
        for (let i = 0; i < this.n; i++) this.players[(buttonIdx + 1 + i) % this.n].cards.push(this.deck.pop());
      this.street = 'flop';
      for (const b of this.boards) b.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.minRaise = bb;
      if (this.canAct().length > 1) this.turn = this.nextActor(buttonIdx, true);
      else this.advance();
      return;
    }
    const headsUp = this.n === 2;  // (a ghost seat counts as a seat in the ring)
    this.sbIdx = headsUp ? buttonIdx : (buttonIdx + 1) % this.n;
    this.bbIdx = headsUp ? (buttonIdx + 1) % this.n : (buttonIdx + 2) % this.n;
    this.postBet(this.sbIdx, sb);
    this.rec('sb', this.players[this.sbIdx].id, this.players[this.sbIdx].bet);
    this.postBet(this.bbIdx, bb);
    this.rec('bb', this.players[this.bbIdx].id, this.players[this.bbIdx].bet);
    // a seat whose player left early only pays its blinds: posted, then folded, never dealt
    for (const p of this.players) if (p.ghost) p.folded = true;
    for (let r = 0; r < this.v.hole; r++)
      for (let i = 0; i < this.n; i++) { const g = this.players[(this.sbIdx + i) % this.n]; if (!g.ghost) g.cards.push(this.deck.pop()); }

    const first = headsUp ? this.sbIdx : (this.bbIdx + 1) % this.n;
    this.turn = this.nextActor(first - 1, true);
    if (this.turn < 0 || this.roundDone()) this.advance();
  }

  // one line of the replay: who put in what, and the pot at that moment
  rec(k, id, a) {
    this.acts.push({ s: this.street, k, id, a: a || 0, pot: this.pot });
  }

  get board() { return this.boards[0]; }

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
    let maxTo = p.bet + p.stack;
    if (this.v.pl) maxTo = Math.min(maxTo, this.currentBet + this.pot + (this.currentBet - p.bet)); // pot-limit: raise by at most the pot after calling
    const toCall = Math.min(this.currentBet - p.bet, p.stack);
    const canRaise = p.canRaise && maxTo > this.currentBet && p.bet + p.stack > this.currentBet;
    const minTo = Math.min(this.currentBet + this.minRaise, maxTo);
    return {
      toCall, canCheck: this.currentBet === p.bet, canRaise,
      minRaiseTo: minTo, maxRaiseTo: maxTo, currentBet: this.currentBet,
      myBet: p.bet, stack: p.stack, pot: this.pot, potLimit: !!this.v.pl,
    };
  }

  act(id, type, amount) {
    if (this.finished) throw new Error('hand is over');
    if (this.runit) throw new Error('waiting for the run-it vote');
    const L = this.legal(id);
    if (!L) throw new Error('not your turn');
    const p = this.players[this.turn];
    if (type === 'fold') {
      p.folded = true; this.log.push(`${id} folds`); this.rec('fold', id, 0);
    } else if (type === 'check') {
      if (!L.canCheck) throw new Error('cannot check');
      p.acted = true; this.rec('check', id, 0);
    } else if (type === 'call') {
      if (L.toCall <= 0) throw new Error('nothing to call');
      this.postBet(this.turn, L.toCall);
      this.rec(p.allIn ? 'allin' : 'call', id, p.bet);
      p.acted = true;
    } else if (type === 'raise') {
      amount = Math.floor(Number(amount));
      if (!L.canRaise) throw new Error('cannot raise');
      if (!(amount > this.currentBet)) throw new Error('raise must be above the current bet');
      if (amount > L.maxRaiseTo) throw new Error(this.v.pl && L.maxRaiseTo < p.bet + p.stack ? 'pot limit: the most you can raise to is ' + L.maxRaiseTo : 'not enough chips');
      if (amount < L.minRaiseTo) throw new Error('raise is below the minimum');
      const raiseSize = amount - this.currentBet;
      const full = raiseSize >= this.minRaise;
      this.postBet(this.turn, amount - p.bet);
      this.rec(p.allIn ? 'allin' : (this.players.some((o) => o !== p && o.bet > 0 && o.acted) || this.street === 'preflop' ? 'raise' : 'bet'), id, p.bet);
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
  afterAction() {
    if (this.live().length === 1) return this.finishUncontested();
    if (this.runit) { if (this.runit.voters.filter((v) => !this.players.find((p) => p.id === v).folded).every((v) => this.runit.votes[v])) this.resolveRunIt(); return; }
    if (this.roundDone()) return this.advance();
    this.turn = this.nextActor(this.turn);
  }

  // how many times the rest of the board can be dealt from what is left of the deck
  maxRuns() {
    const left = { preflop: 3, flop: 2, turn: 1 }[this.street] || 0;
    const need = (5 - this.boards[0].length) + left;
    return need ? Math.min(3, Math.floor(this.deck.length / need)) : 0;
  }
  // all betting is over but cards are still to come: players may vote to deal them more than once
  // One vote per hand. Without runitDone a vote that comes out as "once" leaves runs at 1, so the
  // next street opens another vote, and a table where nobody votes never finishes the hand.
  runItDue() {
    return !this.runit && !this.runitDone && this.runs === 1 && canRunIt(this.variant) && this.runItMin > 0 && this.pot >= this.runItMin
      && this.street !== 'river' && this.live().length > 1 && this.canAct().length <= 1 && this.maxRuns() >= 2;
  }

  // vote: 1, 2 or 3 times. Most common choice wins, a tie goes to the lowest. No vote counts as 1.
  vote(id, n) {
    if (!this.runit) throw new Error('no vote is open');
    if (!this.runit.voters.includes(id)) throw new Error('only players still in the hand vote');
    n = Math.floor(Number(n));
    if (!(n >= 1 && n <= this.maxRuns())) throw new Error('choose a number from 1 to ' + this.maxRuns());
    this.runit.votes[id] = n;
    if (this.runit.voters.filter((v) => !this.players.find((p) => p.id === v).folded).every((v) => this.runit.votes[v])) this.resolveRunIt();
  }
  resolveRunIt() {
    if (!this.runit) return;
    const tally = { 1: 0, 2: 0, 3: 0 };
    for (const v of this.runit.voters) tally[this.runit.votes[v] || 1]++;
    let best = 1;
    for (const k of [2, 3]) if (tally[k] > tally[best]) best = k;
    this.runit.result = best;
    this.runs = best;
    const was = this.runit;
    this.runit = null;
    this.runitDone = true;
    this.runitInfo = { votes: was.votes, voters: was.voters, runs: best };
    this.advance();
  }

  advance() {
    while (!this.finished) {
      if (this.live().length === 1) return this.finishUncontested();
      for (const p of this.players) { p.bet = 0; p.acted = false; p.canRaise = true; }
      this.currentBet = 0; this.minRaise = this.bb;
      if (this.street === 'river') return this.showdown();
      if (this.runItDue()) { this.runit = { voters: this.live().map((p) => p.id), votes: {} }; this.turn = -1; return; }
      if (this.runs > 1) return this.finishRuns();
      this.dealNext();
      if (this.canAct().length > 1) {
        this.turn = this.nextActor(this.buttonIdx, true);
        return;
      }
      // nobody can bet any more: deal the rest of the board
    }
  }

  // Next street on every board. A card is burned first, as at a real table - but the burn is a
  // courtesy and the board is not, so when the deck is tight the burn is what gives way.
  //
  // Three 5-card flops with seven players is the hand that decides this: 35 cards in people's
  // hands and 15 on the boards is 50 of the 52, and the three burns do not all fit. Dealing the
  // river without burning is what a real table does when the deck is short, and it is what the
  // portal does here.
  //
  // The throw matters as much as the skip. An empty deck hands back nothing rather than
  // complaining, so without this a board would quietly take a card that is not a card and the
  // hand would be scored on it. Better to stop the hand and say so.
  dealNext() {
    const each = this.street === 'preflop' ? 3 : 1;
    const need = this.boards.length * each;
    if (this.deck.length < need) {
      throw new Error('Not enough cards left to finish the board - too many players for this game');
    }
    if (this.deck.length > need) this.deck.pop();        // the burn, if the deck can spare it
    if (this.street === 'preflop') this.street = 'flop';
    else if (this.street === 'flop') this.street = 'turn';
    else this.street = 'river';
    for (const b of this.boards) for (let i = 0; i < each; i++) b.push(this.deck.pop());
  }

  // the board is dealt out `runs` times from where it stands
  finishRuns() {
    const base = this.boards[0].slice(), street = this.street;
    const runs = [];
    for (let r = 0; r < this.runs; r++) {
      this.boards = [base.slice()]; this.street = street;
      while (this.street !== 'river') this.dealNext();
      runs.push(this.boards[0]);
    }
    this.boards = runs; this.boardKind = 'runs';
    this.showdown();
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
    this.finished = true; this.turn = -1; this.runit = null;
    this.result = {
      uncontested: true, reveal: {}, won: { [w.id]: total }, boardResults: [],
      pots: [{ amount: total, eligible: [w.id], winners: [{ id: w.id, share: total }] }],
    };
  }

  showdown() {
    this.street = 'showdown';
    const live = this.live();
    // every board (several flops, or several runs) is scored on its own
    const boardResults = this.boards.map((board) => {
      const hands = {};
      for (const p of live) { const e = evalHand(this.variant, p.cards, board); hands[p.id] = { score: e.score, handName: categoryOf(e.score), best: e.five }; }
      return { board: board.slice(), hands, winners: {} };
    });
    const B = boardResults.length;
    // Three flops are one pot played three ways, not three pots. Each board is worth a point,
    // shared when a board is split, and whoever ends with the most points takes the whole thing -
    // so you have to be good on two of the three, and winning one board while somebody else wins
    // the other two is worth nothing at all. Level at the top and the pot is split between those
    // who are level.
    //
    // Two boards are not played that way and stay as they were: each board takes its own half of
    // the pot. Points need an odd number to settle anything - on two boards one each is level and
    // both to one player is a scoop, which is what splitting per board already does - so the only
    // thing points would change there is a hand where one board is split, and turning that into
    // winner-takes-all is a rule nobody asked for.
    //
    // Running it twice stays per board too, whatever the number: that is one hand dealt out more
    // than once to cut the luck, so each run takes its own share.
    const byPoints = B > 2 && this.boardKind === 'boards';
    const won = {};

    // what each board came to, over everybody still in the hand - for the table to show, kept
    // apart from the pots because a side pot is contested by fewer people than the board was
    const points = {};
    if (byPoints) {
      for (const p of live) points[p.id] = 0;
      for (let b = 0; b < B; b++) {
        let best = -1;
        for (const p of live) best = Math.max(best, boardResults[b].hands[p.id].score);
        const ws = live.filter((p) => boardResults[b].hands[p.id].score === best).map((p) => p.id);
        for (const id of ws) {
          points[id] += 1 / ws.length;
          boardResults[b].winners[id] = 1 / ws.length;
        }
      }
    }

    const pots = this.buildPots().map((pot) => {
      const out = {};
      if (byPoints) {
        // the same count again, but only among those who paid into this pot
        const pts = {};
        for (const id of pot.eligible) pts[id] = 0;
        for (let b = 0; b < B; b++) {
          let best = -1;
          for (const id of pot.eligible) best = Math.max(best, boardResults[b].hands[id].score);
          const ws = pot.eligible.filter((id) => boardResults[b].hands[id].score === best);
          for (const id of ws) pts[id] += 1 / ws.length;
        }
        let top = 0;
        for (const id of pot.eligible) top = Math.max(top, pts[id]);
        // a board split three ways is a third of a point, which does not land on a round number,
        // so the comparison is made with a little room rather than exactly
        const takers = pot.eligible.filter((id) => pts[id] > top - 1e-9);
        takers.sort((a, c) => this.dist(a) - this.dist(c));
        const base = Math.floor(pot.amount / takers.length);
        let extra = pot.amount - base * takers.length;
        for (const id of takers) {
          const share = base + (extra-- > 0 ? 1 : 0);
          won[id] = (won[id] || 0) + share;
          out[id] = (out[id] || 0) + share;
        }
      } else {
        for (let b = 0; b < B; b++) {
          // each board takes an equal part of the pot (the first boards take any odd chips)
          const part = Math.floor(pot.amount / B) + (b < pot.amount % B ? 1 : 0);
          if (!part) continue;
          let best = -1;
          for (const id of pot.eligible) best = Math.max(best, boardResults[b].hands[id].score);
          const winners = pot.eligible.filter((id) => boardResults[b].hands[id].score === best);
          // odd chips go to the winners closest to the left of the button
          winners.sort((a, c) => this.dist(a) - this.dist(c));
          const base = Math.floor(part / winners.length);
          let extra = part - base * winners.length;
          for (const id of winners) {
            const share = base + (extra-- > 0 ? 1 : 0);
            won[id] = (won[id] || 0) + share;
            out[id] = (out[id] || 0) + share;
            boardResults[b].winners[id] = (boardResults[b].winners[id] || 0) + share;
          }
        }
      }
      return { amount: pot.amount, eligible: pot.eligible, winners: Object.entries(out).map(([id, share]) => ({ id, share })) };
    });
    for (const p of this.players) if (won[p.id]) p.stack += won[p.id];
    const reveal = {};
    for (const p of live) {
      // the hand shown for a player is their best across the boards
      let bi = 0;
      boardResults.forEach((br, i) => { if (br.hands[p.id].score > boardResults[bi].hands[p.id].score) bi = i; });
      const h = boardResults[bi].hands[p.id];
      reveal[p.id] = { cards: p.cards.slice(), handName: h.handName, best: h.best };
    }
    this.finished = true; this.turn = -1;
    this.result = { uncontested: false, reveal, won, pots, boardResults, boardKind: this.boardKind,
      points: byPoints ? points : null, boardsPlayed: B };
  }

  dist(id) {
    const i = this.players.findIndex((p) => p.id === id);
    return (i - this.buttonIdx - 1 + this.n * 2) % this.n;
  }

  // What one viewer is allowed to see
  view(viewerId) {
    const showAll = this.result && !this.result.uncontested;
    const L = viewerId ? this.legal(viewerId) : null;
    const hidden = () => Array(this.v.hole).fill('??');
    return {
      variant: this.variant, variantName: this.v.name, hole: this.v.hole,
      street: this.street,
      board: this.boards[0].slice(),
      boards: this.boards.map((b) => b.slice()), boardKind: this.boardKind,
      pot: this.pot,
      currentBet: this.currentBet,
      turnId: this.turnId,
      finished: this.finished,
      legal: L,
      runit: this.runit ? { max: this.maxRuns(), voters: this.runit.voters.slice(), mine: this.runit.votes[viewerId] || 0, voted: Object.keys(this.runit.votes).length } : null,
      runs: this.runs,
      players: this.players.map((p) => ({
        id: p.id, seat: p.seat, stack: p.stack, bet: p.bet, invested: p.invested,
        folded: p.folded, allIn: p.allIn, ghost: p.ghost,
        isButton: this.players[this.buttonIdx] === p,
        cards: p.id === viewerId ? p.cards.slice()
          : (showAll && !p.folded ? p.cards.slice() : (p.folded ? null : hidden())),
      })),
    };
  }
}

module.exports = { Hand, newDeck, shuffle, score5, bestFive, bestOmaha, evalHand, categoryOf, CATEGORY, VARIANTS, canRunIt, RANKS, SUITS };
