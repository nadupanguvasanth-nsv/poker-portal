'use strict';
// Copyright (c) 2026 Vashanth Somasundaram. All rights reserved. See LICENSE.
// The lobby: every table that is running or waiting, who is running it, and who is in it.
//
// Any member can start a table, and whoever starts it is its game admin. The portal admin can see
// and do everything, everywhere. Nobody else can touch a table they do not run.

const { Table, FORMATS, PICKABLE, SEATS, TOURNEY, cleanSettings } = require('./games');
const HOUSE = require('./house');

function makeLobby(ctx) {
  const { state, changed, httpErr, people, broadcast } = ctx;
  const tables = new Map();                 // code -> Table

  const get = (code) => tables.get(String(code || '').toUpperCase()) || null;
  const need = (code) => {
    const t = get(code);
    if (!t) throw httpErr(404, 'That table is not here any more');
    return t;
  };
  const runs = (t, m) => t.isAdmin(m.id) || m.isAdmin;   // the game admin, or the portal admin
  const mustRun = (t, m) => {
    if (!runs(t, m)) throw httpErr(403, `Only ${t.adminName} runs this table`);
    return t;
  };

  // What the lobby list shows: enough to choose a table, and nothing private.
  function card(t, m) {
    const mine = t.byMember(m.id);
    const fmt = FORMATS[t.format];
    return {
      code: t.code, format: t.format, formatName: fmt.name, variant: t.variant,
      variantName: t.variant ? require('./engine').VARIANTS[t.variant].name : '',
      admin: t.adminName, adminId: t.adminId, iRunIt: runs(t, m),
      status: t.status, paused: !!t.paused, players: t.seated().length, seats: SEATS, free: t.freeSeats(),
      minMinutes: t.settings.minMinutes || 0,
      // everything the rules sheet states, taken from the table itself so it cannot drift
      maxBuyin: t.settings.maxBuyin, turnSeconds: t.settings.turnSeconds,
      minPlayers: t.settings.minPlayers, bombAnteBB: t.settings.bombAnteBB,
      lastHands: t.lastHands || 0, endAt: t.endAt || 0,
      // whose regular game this is, and whether the person looking is in it
      groupName: t.groupName || '', inGroup: !t.groupId || (t.groupMembers || []).includes(m.id) || runs(t, m),
      // the portal's own figures, so the rules sheet states what the server actually enforces
      house: {
        graceSeconds: Math.round(HOUSE.START_GRACE_MS / 1000),
        roundTo: HOUSE.ROUND_TO,
        yellowHours: Math.round(HOUSE.YELLOW_AFTER_MS / 3600e3),
        redHours: Math.round(HOUSE.RED_AFTER_MS / 3600e3),
        redAtDebts: HOUSE.RED_AT_DEBTS,
      },
      blinds: t.blinds(), minBuyin: t.settings.minBuyin, startedAt: t.startedAt, createdAt: t.createdAt,
      handNo: t.handNo, level: t.format === 'tournament' ? t.level : 0,
      iAmIn: !!mine, asked: t.requests.some((r) => r.memberId === m.id),
      waiting: t.status === 'waiting' ? t.canStart() : '',
      // A flag follows the name wherever the name appears. Everybody sees the mark; what is
      // behind it is for the person themselves, whoever brought them in, and the portal admin.
      names: t.seated().map((p) => p.name),
      marks: t.seated().map((p) => ({ name: p.name, flag: (ctx.flagOf && ctx.flagOf(p.memberId)) || '' })),
      requests: runs(t, m) ? t.requests.slice() : [],
      leaveAsks: runs(t, m) ? t.seated().filter((p) => p.leaveAsk && !p.leaveOk).map((p) => ({ id: p.id, name: p.name })) : [],
    };
  }

  function list(m) {
    return [...tables.values()]
      .filter((t) => t.status !== 'ended')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => card(t, m));
  }

  // The message the game admin sends to the group chat.
  function invite(t, base) {
    const when = new Date(t.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: process.env.TZ_LABEL || 'Asia/Kolkata' });
    const what = FORMATS[t.format].name + (t.variant ? ' with ' + require('./engine').VARIANTS[t.variant].name : '');
    const terms = t.format === 'tournament'
      ? `${t.settings.minBuyin.toLocaleString('en-IN')} chips each, blinds ${t.blinds().sb}/${t.blinds().bb} doubling every ${Math.round((t.settings.levelMs || TOURNEY.levelMs) / 60000)} minutes`
      : `blinds ${t.blinds().sb}/${t.blinds().bb}`;
    return `A game is planned by ${t.adminName} on ${when}.\n\n${what}, ${terms}.\n\n`
      + `It is a ${SEATS}-player table and seats go first come, first served, so come in early if you want one.\n\n`
      + `Join here: ${base}`;
  }

  return {
    tables, get, need, runs, mustRun, card, list, invite,

    // ---- starting one ----
    open(m, b) {
      const format = String(b.format || 'holdem');
      if (!FORMATS[format]) throw httpErr(400, 'Pick a game');
      if (FORMATS[format].needsVariant && !PICKABLE.includes(b.variant)) throw httpErr(400, 'Pick the variant to go with it');
      const running = [...tables.values()].filter((t) => t.status !== 'ended' && t.adminId === m.id);
      if (running.length >= 2) throw httpErr(400, 'You are already running two tables. Finish one first.');
      // A table opened to one of his groups: the people in it walk in as they would anywhere,
      // and anybody else has to ask. The table is not hidden - everybody sees it and sees that
      // it is somebody's regular game, which is less pointed than a game that is simply not there.
      let group = null;
      if (b.group) {
        group = people.findGroup(String(b.group));
        if (!group) throw httpErr(404, 'No such group');
        if (group.ownerId !== m.id && !m.isAdmin) throw httpErr(403, 'That is not your group');
      }
      let t;
      try { t = new Table({ format, variant: b.variant, admin: m, settings: b.settings, title: b.title }); }
      catch (err) { throw httpErr(400, err.message); }
      if (group) {
        t.groupId = group.id;
        t.groupName = group.name;
        t.groupMembers = group.members.slice();
      }
      while (tables.has(t.code)) t.code = t.code.slice(0, 3) + Math.floor(Math.random() * 10);
      tables.set(t.code, t);
      t.say(`${m.name} opened the table`);
      const me = t.sit(m);                          // whoever starts it is sitting at it
      if (format !== 'tournament') t.give(me, t.settings.minBuyin);
      changed();
      return t;
    },

    // ---- coming in ----
    // Before play begins anybody may take a free seat. Once it is running, the game admin decides.
    join(m, b) {
      const t = need(b.code);
      if (t.status === 'ended') throw httpErr(400, 'That game has finished');
      const mine = t.byMember(m.id);
      if (mine && !mine.out) return { seated: true };
      if (t.format === 'tournament' && t.startedAt) throw httpErr(400, 'A tournament takes no late entries');
      if (!t.freeSeats()) throw httpErr(400, 'The table is full');
      // Somebody from outside a closed group asks, whether or not the game has started. Whoever
      // runs the table can let him in as a guest - a group saves him chasing people, it does not
      // lock him out of his own game.
      const outsider = t.groupId && !runs(t, m) && !(t.groupMembers || []).includes(m.id);
      if (outsider || (t.status === 'playing' && !runs(t, m))) {
        if (t.requests.some((r) => r.memberId === m.id)) return { asked: true };
        t.requests.push({ memberId: m.id, name: m.name, at: Date.now(), guest: !!outsider });
        broadcast(t);
        return { asked: true, guest: !!outsider };
      }
      const p = t.sit(m);
      if (t.format === 'tournament') { /* the stack came with the seat */ }
      else if (!p.bought) t.give(p, t.settings.minBuyin);
      changed(); broadcast(t);
      return { seated: true };
    },

    // The game admin's answer to somebody asking to come in.
    decide(m, b) {
      const t = mustRun(need(b.code), m);
      const i = t.requests.findIndex((r) => r.memberId === b.memberId);
      if (i < 0) throw httpErr(404, 'Nobody is waiting on that');
      const [req] = t.requests.splice(i, 1);
      if (!b.ok) { t.say(`${req.name} was not let in`); changed(); broadcast(t); return { ok: true, let: false }; }
      if (!t.freeSeats()) throw httpErr(400, 'There is no seat free now');
      const member = people.byId(req.memberId);
      if (!member) throw httpErr(404, 'No such member');
      const p = t.sit(member);
      if (t.format !== 'tournament' && !p.bought) t.give(p, t.settings.minBuyin);
      changed(); broadcast(t);
      return { ok: true, let: true };
    },

    // ---- leaving ----
    // Leaving early normally costs you your blinds until the game ends. The game admin can waive
    // that, and it is his call.
    // Leaving. Whoever opens a table can ask people to stay a while, so that a game does not fall
    // apart the moment somebody is ahead. Three ways out before that time is up: you have lost the
    // lot and have nothing to stay for, the game admin lets you go, or you sit there paying your
    // blinds until your time is up. Once the time has been served nobody has to ask anybody.
    askLeave(m, b) {
      const t = need(b.code);
      const p = t.byMember(m.id);
      if (!p) throw httpErr(400, 'You are not at this table');
      if (t.servedTime(p)) {
        p.leaveOk = true;
        t.say(p.stack <= 0 ? `${p.name} is out of chips and is leaving` : !t.ahead(p) ? `${p.name} is not ahead and is leaving` : `${p.name} has stayed the time and is leaving`);
        changed(); broadcast(t);
        return { asked: false, leaving: true };
      }
      p.leaveAsk = Date.now();
      t.say(`${p.name} asked to leave early`);
      changed(); broadcast(t);
      return { asked: true, leaving: false };
    },
    decideLeave(m, b) {
      const t = mustRun(need(b.code), m);
      const p = t.players.get(b.playerId);
      if (!p || !p.leaveAsk) throw httpErr(404, 'Nobody asked that');
      if (b.ok) {
        p.leaveOk = true;
        t.say(`${p.name} may leave with their chips`);
      } else {
        p.leaveAsk = 0;
        p.forfeit = true;
        const left = Math.max(0, Math.ceil(((p.joinedAt || t.createdAt) + (t.settings.minMinutes || 0) * 60000 - Date.now()) / 60000));
        t.say(`${p.name} was asked to stay. His blinds go in without him until his time is up`
          + (left ? ` - about ${left} more minute${left === 1 ? '' : 's'}` : ''));
      }
      changed(); broadcast(t);
      return { ok: true };
    },

    forget(code) { tables.delete(String(code).toUpperCase()); },
  };
}

module.exports = { makeLobby };
