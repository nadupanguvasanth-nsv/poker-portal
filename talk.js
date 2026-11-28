'use strict';
// Copyright (c) 2026 Vashanth Somasundaram. All rights reserved. See LICENSE.
// Table talk: the one line somebody would have said out loud when a hand ends.
//
// It is put in the mouth of a player at the table - the one who took the pot - or of one of the
// five dogs looking on, and it is chosen
// from nothing but what the whole table has already seen: the cards turned over at a showdown,
// the bets that were made, who has chips left. A hand won without a showdown says nothing about
// the cards that won it, because nobody saw them.
const { evalHand } = require('./engine');

// Several ways of saying each thing, so a night does not hear the same line all evening.
const LINES = {
  royal: [
    'Royal flush. Frame it.',
    'Ten to the ace, all one suit. You may never see it again.',
    'Take a picture. That is the best hand there is.',
  ],
  monster: [
    'Some days the deck just likes you.',
    'You do not see one of those every night.',
    'I would like to thank the dealer.',
  ],
  seventwo: [
    'The worst hand in poker. Until today.',
    'Seven-two. Read it and weep.',
    'Any two cards can win. Even those two.',
  ],
  bust: [
    "If you can't spot the sucker at the table, it's you.",
    'Thank you for your contribution.',
    'More chips at the counter, if you need them.',
    'One seat lighter. Who is next?',
  ],
  river: [
    'The river gives. The river takes.',
    "There's always a shot. You just have to find it.",
    'One card. That is all it ever takes.',
    'Never count the pot before the river.',
  ],
  ace: [
    'Kiss my ace.',
    'Aces. Accept no substitutes.',
    'An ace in the hand is worth two in the deck.',
  ],
  steal: [
    "Trust me. I'm bluffing.",
    'You will never know. That is the beauty of it.',
    'I always tell the truth at this table. Mostly.',
    'A good fold. Probably.',
  ],
  split: [
    'Half a pot is better than a whole lesson.',
    'We will call that a draw. This time.',
    'Great minds hold alike.',
  ],
  patience: [
    'Patience pays. Eventually.',
    'I fold, I fold, I fold. Then I collect.',
    'Good things come to those who wait for cards.',
  ],
  big: [
    'Fortune favours the bold.',
    'That is how you build a stack.',
    'Stack them neatly, please.',
    'Chips and a chair. That is all I ask for.',
  ],
};
// Half the time it is not a player who speaks but one of the five dogs, and a dog says what a dog
// would say. Which of them, by the kind of moment: Ace for the big ones, Captain Coffee when
// somebody goes broke, Major for patience and aces, Duchess for the river and a shared pot, Doc
// for a bluff and the hand nobody should win with. A dog's line names nobody.
const DOG_FOR = { big: 'ace', monster: 'ace', royal: 'ace', bust: 'captain', patience: 'major', ace: 'major', river: 'duchess', split: 'duchess', steal: 'doc', seventwo: 'doc' };
const DOG_LINES = {
  royal: [
    'A royal flush! I am wagging everything.',
    'Even I would sit and stay for that.',
    'Ten to the ace. I need a lie down.',
  ],
  monster: [
    'I have seen squirrels less surprising.',
    'Somebody check that deck for treats.',
    'Catch me if you can! Nobody can catch that.',
  ],
  seventwo: [
    'Seven-two. Medically, that should not work.',
    'I prescribe that hand to nobody.',
    'Impossible. I checked twice. Then again, I am a dog.',
  ],
  bust: [
    'Another one bites the kibble.',
    'Mayday, mayday. Stack going down.',
    'This is your captain. We have lost a passenger.',
    'Fasten your seat belts. Or don\u2019t. I\u2019m a pug.',
  ],
  river: [
    'Darling, that river was simply rude.',
    'One card, and the whole room gasps. Delicious.',
    'The river has no manners at all.',
    'I felt that one in my ears.',
  ],
  ace: [
    'An ace. Ears up, everybody.',
    'Aces. In my day we saluted them.',
    'Let me think about that. Yes. An ace wins.',
  ],
  steal: [
    'I ran the numbers. Then I chased my tail.',
    'Trust me, I know. That was a bluff. Or not.',
    'My diagnosis: nobody had anything.',
    'I smelled fear. Or possibly ham.',
  ],
  split: [
    'Sharing. How terribly civilised.',
    'Half each. Nobody growl.',
    'A split. I never do that with biscuits.',
  ],
  patience: [
    'Patience. I once waited three hours for a biscuit.',
    'Sit. Stay. Collect.',
    'Good dog. I mean, good fold. Many good folds.',
  ],
  big: [
    'That pot is bigger than my food bowl.',
    'Big pot! Is any of it edible?',
    'I would chase that pot down the street.',
    'So many chips. Not one of them chewable.',
  ],
};
const dogShare = () => Number(process.env.DOG_SHARE || 0.5);

// The rare moments always get their line. The everyday ones only now and then, or the table
// would be talking over every hand.
const ALWAYS = { royal: 1, monster: 1, seventwo: 1, bust: 1, river: 1 };
const SOMETIMES = Number(process.env.TALK_CHANCE || 0.5);
const PATIENT_AFTER = 6;      // hands folded in a row before a win counts as patience
const BIG_BBS = 40;           // a pot worth remarking on, in big blinds

const rankOf = (c) => String(c || '')[0];

// Who was in front with one card to come, going only by the cards that were turned over.
function aheadOnTurn(h) {
  const r = h.result;
  if (!r || r.uncontested || !r.reveal) return null;
  if (!h.boards || h.boards.length !== 1 || h.boards[0].length !== 5) return null;
  if (r.boardsPlayed && r.boardsPlayed !== 1) return null;
  if (h.runs && h.runs !== 1) return null;
  const ids = Object.keys(r.reveal);
  if (ids.length < 2) return null;
  const turn = h.boards[0].slice(0, 4);
  let top = -1, who = [];
  for (const id of ids) {
    let s;
    try { s = evalHand(h.variant, r.reveal[id].cards, turn).score; } catch (err) { return null; }
    if (s > top) { top = s; who = [id]; } else if (s === top) who.push(id);
  }
  return who;
}

// What kind of moment this hand was, and whose line it is. Returns null when it was just a hand.
// `info` carries what the hand itself cannot say: the big blind, who ran out of chips, and how
// many hands in a row each player had folded before this one.
function moment(h, info) {
  const r = h && h.result;
  if (!r || !r.won) return null;
  const winners = Object.keys(r.won).filter((id) => r.won[id] > 0).sort((a, b) => r.won[b] - r.won[a]);
  if (!winners.length) return null;
  const top = winners[0];
  const bb = (info && info.bb) || 1;
  const one = !!(h.boards && h.boards.length === 1) && (!r.boardsPlayed || r.boardsPlayed === 1) && (!h.runs || h.runs === 1);

  if (!r.uncontested && r.reveal) {
    // the hand itself, when it is one people talk about for a week
    for (const id of winners) {
      const v = r.reveal[id];
      if (!v) continue;
      if (v.handName === 'Straight flush') {
        const ranks = (v.best || []).map(rankOf);
        return { kind: ranks.includes('A') && ranks.includes('K') ? 'royal' : 'monster', who: id };
      }
      if (v.handName === 'Four of a kind') return { kind: 'monster', who: id };
    }
    // seven-two, the hand everybody folds, in the one game where it is the worst there is
    if (h.variant === 'holdem' && winners.length === 1 && r.reveal[top]) {
      const mine = r.reveal[top].cards.map(rankOf).sort().join('');
      if (mine === '27') return { kind: 'seventwo', who: top };
    }
  }
  // somebody is out of chips, and the one who took the most of them has something to say
  if (info && info.busted && info.busted.length && !info.busted.includes(top)) return { kind: 'bust', who: top };

  if (!r.uncontested && r.reveal) {
    // behind with one card to come, in front when it came
    if (one && winners.length === 1) {
      const front = aheadOnTurn(h);
      if (front && front.length && !front.includes(top)) return { kind: 'river', who: top };
    }
    // one pot, one board, shared
    if (one && winners.length > 1 && (r.pots || []).some((p) => (p.winners || []).length > 1)) return { kind: 'split', who: top };
    // an ace of his own in the five that won it
    const v = r.reveal[top];
    if (v && winners.length === 1 && (v.cards || []).some((c) => rankOf(c) === 'A' && (v.best || []).includes(c))) return { kind: 'ace', who: top };
  } else if (r.uncontested) {
    // Everybody folded to his bet. Whether he had it is his business, which is the whole joke -
    // but a big blind left alone before anybody bets has stolen nothing.
    const acts = h.acts || [];
    const pushed = acts.some((a) => a.id === top && (a.k === 'bet' || a.k === 'raise' || a.k === 'allin'));
    const gaveUp = acts.filter((a) => a.k === 'fold').length;
    if (pushed && gaveUp >= 1 && r.won[top] >= bb * 4) return { kind: 'steal', who: top };
    return null;
  }
  if (info && info.folded && (info.folded[top] || 0) >= PATIENT_AFTER) return { kind: 'patience', who: top };
  if (r.won[top] >= bb * BIG_BBS) return { kind: 'big', who: top };
  return null;
}

// The line itself: a player's, under his name, or a dog's, under nobody's. `last` is the one said
// before, so the same words never come twice running; `rnd` is the dice, handed in so a test can
// load them.
function choose(h, info, last, rnd) {
  const roll = rnd || Math.random;
  const m = moment(h, info);
  if (!m) return null;
  if (!ALWAYS[m.kind] && roll() >= SOMETIMES) return null;
  const dog = roll() < dogShare() ? DOG_FOR[m.kind] : '';
  const pool = (dog ? DOG_LINES : LINES)[m.kind].filter((x) => x !== last);
  const text = pool[Math.floor(roll() * pool.length) % pool.length];
  return { kind: m.kind, who: m.who, dog, text };
}

module.exports = { choose, moment, aheadOnTurn, LINES, DOG_LINES, DOG_FOR, PATIENT_AFTER, BIG_BBS };
