'use strict';
// The lobby: every table that is running or waiting, who is running it, and who is in it.
//
// Any member can start a table, and whoever starts it is its game admin. The portal admin can see
// and do everything, everywhere. Nobody else can touch a table they do not run.

const { Table, FORMATS, PICKABLE, SEATS, TOURNEY, cleanSettings } = require('./games');

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
      status: t.status, players: t.seated().length, seats: SEATS, free: t.freeSeats(),
      blinds: t.blinds(), minBuyin: t.settings.minBuyin, startedAt: t.startedAt, createdAt: t.createdAt,
      handNo: t.handNo, level: t.format === 'tournament' ? t.level : 0,
      iAmIn: !!mine, asked: t.requests.some((r) => r.memberId === m.id),
      waiting: t.status === 'waiting' ? t.canStart() : '',
      names: t.seated().map((p) => p.name),
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
    return `A game is planned by ${t.adminName} on ${when}.\n\n${what}, blinds ${t.blinds().sb}/${t.blinds().bb}.\n\n`
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
      let t;
      try { t = new Table({ format, variant: b.variant, admin: m, settings: b.settings, title: b.title }); }
      catch (err) { throw httpErr(400, err.message); }
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
      if (t.status === 'playing' && !runs(t, m)) {
        if (t.requests.some((r) => r.memberId === m.id)) return { asked: true };
        t.requests.push({ memberId: m.id, name: m.name, at: Date.now() });
        broadcast(t);
        return { asked: true };
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
    askLeave(m, b) {
      const t = need(b.code);
      const p = t.byMember(m.id);
      if (!p) throw httpErr(400, 'You are not at this table');
      p.leaveAsk = Date.now();
      t.say(`${p.name} asked to leave early`);
      changed(); broadcast(t);
      return { asked: true };
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
        t.say(`${p.name} was asked to stay`);
      }
      changed(); broadcast(t);
      return { ok: true };
    },

    forget(code) { tables.delete(String(code).toUpperCase()); },
  };
}

module.exports = { makeLobby };
