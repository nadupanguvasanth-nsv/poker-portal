'use strict';
// The club: registered members, game nights (events), invitations, approvals,
// delegated roles and reminders. Dependency-free. State is saved to a file in
// the club Gmail account's Google Drive when DRIVE_SCRIPT_URL and DRIVE_SECRET
// are set, otherwise to a local file (fine for testing; Render's free disk is
// wiped on restart).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SEATS_MAX = Number(process.env.SEATS_MAX || 7);
const REPLAY_GAMES = Number(process.env.REPLAY_GAMES || 5); // games that keep their replays
const webpush = require('./webpush');

const ROLES = ['start', 'bank', 'settings', 'players', 'invite'];
const REMIND_MS = 60 * 1000;

// ---------- storage ----------
function fileStore(dir) {
  const file = path.join(dir, 'club.json');
  return {
    name: 'file ' + file,
    async load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } },
    async save(state) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    },
  };
}

// Google Drive through a small Apps Script web app deployed from the club's Gmail
// account. The script reads and writes one JSON file in that account's Drive.
function driveStore(url, secret) {
  return {
    name: 'Google Drive script',
    async load() {
      const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'action=get&key=' + encodeURIComponent(secret), { redirect: 'follow' });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) throw new Error('Drive load failed: ' + (j && j.error ? j.error : r.status));
      return j.value || null;
    },
    async save(state) {
      const r = await fetch(url, {
        method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ key: secret, action: 'set', value: state }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.ok) throw new Error('Drive save failed: ' + (j && j.error ? j.error : r.status));
    },
  };
}

function pickStore(env = process.env) {
  if (env.DRIVE_SCRIPT_URL && env.DRIVE_SECRET) return driveStore(env.DRIVE_SCRIPT_URL, env.DRIVE_SECRET);
  return fileStore(env.DATA_DIR || path.join(__dirname, 'data'));
}

// ---------- optional WhatsApp / SMS through Twilio ----------
async function sendExternal(phone, text, env = process.env, mediaUrl) {
  if (!phone || !env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM) return false;
  const wa = env.TWILIO_CHANNEL === 'whatsapp';
  const to = (wa ? 'whatsapp:' : '') + phone;
  const from = (wa && !/^whatsapp:/.test(env.TWILIO_FROM) ? 'whatsapp:' : '') + env.TWILIO_FROM;
  const base = env.TWILIO_BASE || 'https://api.twilio.com';
  // WhatsApp only allows free-form text within 24 hours of the person's last message. With an approved
  // template (TWILIO_TPL_TEXT = its Content SID, body "{{1}}") every message goes out as that template.
  const form = { To: to, From: from };
  if (wa && env.TWILIO_TPL_TEXT) {
    const flat = (text + (mediaUrl ? ' ' + mediaUrl : '')).replace(/\s*[\r\n]+\s*/g, ' | ').replace(/ {4,}/g, '   ');
    form.ContentSid = env.TWILIO_TPL_TEXT; form.ContentVariables = JSON.stringify({ 1: flat });
  } else { form.Body = text; if (mediaUrl) form.MediaUrl = mediaUrl; }
  const r = await fetch(`${base}/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(env.TWILIO_SID + ':' + env.TWILIO_TOKEN).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });
  if (!r.ok) console.error('Twilio refused the message:', r.status, (await r.text().catch(() => '')).slice(0, 300));
  return r.ok;
}

// ---------- the club ----------
function createClub(ctx) {
  const { tables, makeTable, addPlayer, broadcast, say, httpErr, cleanName, cleanSettings } = ctx;
  const baseUrl = () => (ctx.publicBase ? ctx.publicBase() : '');
  const env = ctx.env || process.env;
  const rid = (n = 16) => crypto.randomBytes(n).toString('hex');
  const store = ctx.store || pickStore(env);
  let state = { club: null, members: {}, events: {} };
  const clients = new Map(); // memberId -> Set(res)
  let saving = Promise.resolve(), dirty = false, timer = null, lastError = '', lastSaved = '', lastSaveAt = 0;

  async function load() {
    let s = null, err = null;
    for (let i = 0; i < 4; i++) { // a stored copy must never be replaced by an empty one because of a hiccup
      try { s = await store.load(); err = null; break; } catch (e) { err = e; await new Promise((r) => setTimeout(r, ctx.retryMs === undefined ? 1500 : ctx.retryMs)); }
    }
    if (err) throw err;
    if (s && s.members && s.events) state = s;
    if (!state.vapid) { state.vapid = webpush.makeVapid(); persist(); } // keys for phone push notifications
    console.log('Club storage: ' + store.name + (state.club ? ` (club "${state.club.name}", ${Object.keys(state.members).length} members)` : ' (no club yet)'));
  }
  function persist() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!dirty) return;
      dirty = false;
      const snap = JSON.parse(JSON.stringify(state));
      // Google Drive is reached through an Apps Script with a daily time budget, so an
      // unchanged club is never written twice and writes are spaced out.
      const text = JSON.stringify(snap);
      if (text === lastSaved) return;
      const gap = ctx.saveMinMs !== undefined ? ctx.saveMinMs : (ctx.saveDelayMs !== undefined ? 0 : Number(process.env.CLUB_SAVE_MIN_MS || 15000));
      const wait = Math.max(0, lastSaveAt + gap - Date.now());
      if (wait > 0) { dirty = true; timer = setTimeout(() => { timer = null; if (dirty) { dirty = false; persist(); } }, wait); if (timer.unref) timer.unref(); return; }
      lastSaved = text; lastSaveAt = Date.now();
      saving = saving.then(() => store.save(snap)).then(() => { lastError = ''; }).catch((e) => { lastError = e.message; console.error('Club save failed:', e.message); dirty = true; const r = setTimeout(persist, 5000); if (r.unref) r.unref(); });
    }, ctx.saveDelayMs === undefined ? 200 : ctx.saveDelayMs);
    if (timer.unref) timer.unref();
  }
  // live tables are kept in the same saved copy, so a restart does not lose the game
  const setTables = (obj) => { state.tables = obj; persist(); };
  const getTables = () => state.tables || {};
  const flush = async () => { if (timer) { clearTimeout(timer); timer = null; } dirty = false; await saving; const text = JSON.stringify(state); lastSaved = text; lastSaveAt = Date.now(); await store.save(JSON.parse(text)); };

  // ----- helpers -----
  const owner = () => state.club && state.members[state.club.ownerId];
  const signinFails = {};
  const memberByToken = (tok) => Object.values(state.members).find((m) => tok && m.token === tok);
  function auth(b) {
    const m = memberByToken(String(b.mtoken || ''));
    if (!m) throw httpErr(401, 'This invite link is not valid. Ask the admin for a new one.');
    return m;
  }
  const isOwner = (m) => !!state.club && m.id === state.club.ownerId;
  // Powers are delegated per game (one room) and end with that game; only the admin holds club-wide powers.
  const isCo = (m) => !!m.coAdmin && !isOwner(m); // a co-admin appointed by the admin: club-wide helper
  const evRoles = (ev, m) => isCo(m) ? ROLES.slice() : ((ev.delegates && ev.delegates[m.id]) || []);
  const hasEv = (m, ev, role) => isOwner(m) || evRoles(ev, m).includes(role);
  const mgrOnly = (m) => { if (!isOwner(m) && !isCo(m)) throw httpErr(403, 'Only the admin or a co-admin can do that'); };
  const ownerOnly = (m) => { if (!isOwner(m)) throw httpErr(403, 'Only the admin can do that'); };
  const cleanPhone = (p) => { const x = String(p || '').replace(/[^\d+]/g, '').slice(0, 16); return /^\d{10}$/.test(x) ? '+91' + x : x; };
  const cleanRoles = (r) => [...new Set((Array.isArray(r) ? r : []).filter((x) => ROLES.includes(x)))];
  const cleanTitle = (t) => String(t || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || 'Game night';

  // A game with no name of its own gets one from the day and hour it is set for,
  // so "Saturday Night Shootout" rather than "Game night" every time.
  const NAME_POOLS = {
    dawn: ['Graveyard Shift', 'Midnight Run', 'Last Call', 'Small Hours', 'Insomniacs'],
    morning: ['Morning Shuffle', 'Sunrise Session', 'Early Shuffle', 'Morning Warm-up', 'Breakfast Bluffs'],
    afternoon: ['Matinee', 'Afternoon Session', 'Afternoon Grind', 'Daylight Shuffle', 'Long Afternoon'],
    evening: ['Evening Showdown', 'Shootout', 'Standoff', 'Evening Session', 'Table Talk'],
    night: ['Night Showdown', 'Night Shootout', 'Late Shuffle', 'Night Owls', 'All-in Night'],
  };
  function autoTitle(startAt) {
    const tz = env.STATEMENT_TZ || env.TZ_LABEL || 'Asia/Kolkata';
    let day, hour;
    try {
      const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', hour: 'numeric', hour12: false });
      const parts = f.formatToParts(new Date(startAt));
      day = (parts.find((p) => p.type === 'weekday') || {}).value;
      hour = Number((parts.find((p) => p.type === 'hour') || {}).value);
    } catch (e) { const d = new Date(startAt); day = d.toLocaleDateString('en-GB', { weekday: 'long' }); hour = d.getHours(); }
    const part = hour < 5 ? 'dawn' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
    const pool = NAME_POOLS[part];
    return cleanTitle(`${day} ${pool[Math.floor(Math.random() * pool.length)]}`);
  }

  function canSee(ev, m) {
    const mgr = isOwner(m) || evRoles(ev, m).length > 0;
    if (ev.status === 'cancelled') return mgr ? Date.now() < ev.startAt + 6 * 3600e3 : false;
    if (Date.now() > ev.startAt + 6 * 3600e3 && ev.status !== 'live') return false;
    return mgr || ev.invited === 'all' || (Array.isArray(ev.invited) && ev.invited.includes(m.id));
  }
  const approvedIds = (ev) => Object.keys(ev.people).filter((id) => ev.people[id].state === 'approved');
  const seatCap = (ev) => ev.seats - (ev.adminPlays === false ? 0 : 1); // the admin holds a seat only when playing
  const seatsLeft = (ev) => seatCap(ev) - approvedIds(ev).length;
  const waitlist = (ev) => Object.keys(ev.people).filter((id) => ev.people[id].state === 'waitlist').sort((a, b) => ev.people[a].at - ev.people[b].at);
  const tableOpen = (ev) => { const t = ev.tableCode && tables.get(ev.tableCode); return !!(t && !t.closed); };

  function viewFor(m) {
    const events = Object.values(state.events)
      .filter((ev) => canSee(ev, m))
      .sort((a, b) => a.startAt - b.startAt)
      .map((ev) => {
        const mine = ev.people[m.id];
        const manage = hasEv(m, ev, 'invite');
        const o = {
          id: ev.id, title: ev.title, startAt: ev.startAt, seats: ev.seats, cancelled: ev.status === 'cancelled', done: ev.status === 'done',
          settings: ev.settings, approvedCount: approvedIds(ev).length, tableOpen: tableOpen(ev), auto: !!ev.auto, wait: mine && mine.state === 'waitlist' ? waitlist(ev).indexOf(m.id) + 1 : 0, waitCount: waitlist(ev).length,
          proposal: !!ev.proposal, confirmed: !!ev.confirmed, adminPlays: ev.adminPlays !== false, guestSeats: seatCap(ev),
          actingId: ev.actingId || '', actingName: ev.actingId && state.members[ev.actingId] ? state.members[ev.actingId].name : '',
          my: isOwner(m) ? 'owner' : (mine ? mine.state : 'invited'), manage, myRoles: isOwner(m) ? [] : evRoles(ev, m),
        };
        if (manage) {
          o.invited = ev.invited;
          o.people = Object.values(state.members)
            .filter((x) => !isOwner(x) && (ev.invited === 'all' || (ev.invited || []).includes(x.id) || ev.people[x.id]))
            .map((x) => ({ id: x.id, name: x.name, phone: x.phone || '', state: ev.people[x.id] ? ev.people[x.id].state : 'invited', roles: evRoles(ev, x) }));
        }
        return o;
      });
    const out = {
      club: { name: state.club.name },
      me: { id: m.id, name: m.name, phone: m.phone || '', isOwner: isOwner(m), isCo: isCo(m), manage: isOwner(m) || isCo(m), hasPin: !!m.pin },
      events, now: Date.now(), roles: ROLES, saveError: isOwner(m) ? lastError : '', storage: isOwner(m) ? store.name : '',
    };
    // every member sees the past games and the replays; only the owner can remove one
    out.history = (state.history || []).slice().reverse().slice(0, 100).map((g) => ({ ...g, rounds: undefined, replays: g.rounds ? g.rounds.length : 0 }));
    if (isOwner(m) || isCo(m)) out.members = Object.values(state.members).filter((x) => !isOwner(x)).map((x) => ({ id: x.id, name: x.name, phone: x.phone || '', token: x.token, createdAt: x.createdAt, coAdmin: !!x.coAdmin }));
    return out;
  }

  function push(m, eventName, data) {
    const set = clients.get(m.id);
    if (!set) return;
    for (const res of set) { try { res.write((eventName ? 'event: ' + eventName + '\n' : '') + 'data: ' + JSON.stringify(data) + '\n\n'); } catch (e) { /* closed */ } }
  }
  function broadcastClub() {
    if (!state.club) return;
    for (const id of clients.keys()) { const m = state.members[id]; if (m) push(m, '', viewFor(m)); }
  }
  const changed = () => { persist(); broadcastClub(); };

  // first come, first served: when a seat frees up the next person waiting gets it
  function promote(ev) {
    for (const id of waitlist(ev)) {
      if (seatsLeft(ev) <= 0) break;
      const x = state.members[id];
      if (!x) { delete ev.people[id]; continue; }
      ev.people[id] = { state: 'approved', at: Date.now() };
      tell(x, 'allotted', `A seat opened up. You are in for ${ev.title}. Open Smart Buddies and tap Join table.`, { eventId: ev.id });
    }
  }
  function lateReply(m, ev, st) { // tell the admin so the game link can be sent
    const o = owner(); if (!o) return;
    tell(o, 'late', st === 'approved' ? `${m.name} replied late and was given a seat at ${ev.title}. Send them the game link.` : `${m.name} replied late. The table is full, so they are on the waiting list for ${ev.title}.`, { eventId: ev.id });
  }
  function rsvp(m, ev, answer) {
    if (!ev || ev.status === 'cancelled' || ev.status === 'done' || !canSee(ev, m)) throw httpErr(404, 'This game is not open any more');
    if (isOwner(m)) throw httpErr(400, 'You are the admin. You are always seated.');
    const cur = ev.people[m.id];
    if (answer === 'in') {
      if (cur && (cur.state === 'approved' || cur.state === 'waitlist')) return cur.state;
      if (ev.proposal && !ev.confirmed) { ev.people[m.id] = { state: 'interested', at: Date.now() }; changed(); return 'interested'; }
      ev.people[m.id] = seatsLeft(ev) > 0 ? { state: 'approved', at: Date.now() } : { state: 'waitlist', at: Date.now() };
      if (ev.proposal) lateReply(m, ev, ev.people[m.id].state);
    } else {
      const had = cur && cur.state === 'approved';
      ev.people[m.id] = { state: 'declined', at: Date.now(), out: true };
      if (had) promote(ev);
    }
    changed();
    return ev.people[m.id].state;
  }
  const rsvpLink = (m, ev, a) => `${baseUrl()}/r/${m.token}/${ev.id}/${a}`;
  function rsvpPage(mtoken, evId, answer, opt) {
    const m = memberByToken(mtoken), ev = state.events[evId];
    const base = (opt && opt.base) || baseUrl();
    const og = (t, d) => `<meta property="og:title" content="${String(t).replace(/[<>&"]/g, '')}"><meta property="og:description" content="${String(d).replace(/[<>&"]/g, '')}"><meta property="og:image" content="${base}/poster.jpg"><meta property="og:type" content="website"><meta name="twitter:card" content="summary_large_image">`;
    const page = (title, msg, open) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Smart Buddies</title>${og(ev ? ev.title : 'Smart Buddies', ev ? 'A private poker party for us. Tap to say if you are in.' : 'Our own poker table.')}<body style="margin:0;background:#0b0e0c;color:#f2efe6;font-family:-apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center"><div style="max-width:340px;padding:24px"><div style="color:#d8b45c;letter-spacing:.2em;font-size:12px;font-weight:700">SMART BUDDIES</div><h1 style="font-size:34px;margin:12px 0 8px">${title}</h1><p style="color:#a3aba5;line-height:1.5">${msg}</p>${open ? `<a href="/?m=${m.token}" style="display:block;margin-top:20px;padding:15px;border-radius:12px;background:#d8b45c;color:#1b1608;font-weight:700;text-decoration:none">Open the table</a>` : ''}</div></body>`;
    const esc = (s) => String(s).replace(/[<>&"]/g, '');
    if (!m || !ev) return page('Link not valid', 'Ask the admin for a new invite.', false);
    // a link preview is only looking: never answer for the member
    if (opt && opt.preview) return page(ev.title, 'A private poker party for us. Open this on your phone to reply.', false);
    try {
      const st = rsvp(m, ev, answer === 'out' ? 'out' : 'in');
      if (st === 'approved' && ev.proposal && ev.confirmed) return page("You're in", `${esc(ev.title)}. You replied after the group was confirmed and there was still a seat, so you are in. The admin will send you the game link.`, true);
      if (st === 'interested') return page('Thanks, noted', `${esc(ev.title)}. You are marked as available. The admin will send you the game link once the group is confirmed.`, false);
      if (st === 'approved') return page("You're in", `${esc(ev.title)}. Your seat is held. Open the table whenever you like and you will be seated with the minimum buy-in.`, true);
      if (st === 'waitlist') return page('Table is full', `${esc(ev.title)}. You are on the waiting list and will get a seat if someone drops out.`, true);
      return page("You're out", `Thanks for letting us know. Changed your mind? Tap the In link again.`, false);
    } catch (e) { return page('Sorry', esc(e.message), false); }
  }

  // ----- phone push notifications -----
  const pushSend = ctx.pushSend || webpush.send;
  async function pushMember(m, payload) {
    const subs = (m && m.push) || [];
    if (!subs.length || !state.vapid) return;
    const dead = [];
    await Promise.all(subs.map(async (s) => {
      try { const r = await pushSend(s, payload, state.vapid, env.PUSH_SUBJECT || 'mailto:' + (env.PUSH_EMAIL || 'admin@example.com')); if (r && r.gone) dead.push(s.endpoint); }
      catch (e) { console.error('Push failed:', e.message); }
    }));
    if (dead.length) { m.push = subs.filter((s) => !dead.includes(s.endpoint)); persist(); }
  }
  function inviteText(ev) { return `${ev.title}: ${new Date(ev.startAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: env.TZ_LABEL || 'Asia/Kolkata' })}`; }
  function tell(m, kind, text, extra) {
    push(m, 'notice', { kind, text, ...extra });
    pushMember(m, { title: 'Smart Buddies', body: text, tag: kind + (extra && extra.eventId ? extra.eventId : ''), url: '/' });
    sendExternal(m.phone, 'Smart Buddies: ' + text, env).catch((e) => console.error('External message failed:', e.message));
  }

  // ----- tables for game nights -----
  function openTable(ev) {
    let t = ev.tableCode && tables.get(ev.tableCode);
    if (t && !t.closed) return t;
    const o = owner();
    const made = makeTable(o.name, ev.settings);
    t = made.t;
    t.membersOnly = true; t.eventId = ev.id;
    made.admin.memberId = o.id; made.admin.roles = [];
    ev.status = ev.status === 'scheduled' ? 'live' : ev.status;
    ev.tableCode = t.code;
    say(t, `Table opened for ${ev.title}`);
    persist();
    return t;
  }

  // Delegated powers for one game: stored on the game and on its table, cleared when the game ends.
  function setDelegates(ev, m, roles, fromTable) {
    roles = cleanRoles(roles);
    if (!ev.delegates) ev.delegates = {};
    if (roles.length) ev.delegates[m.id] = roles; else delete ev.delegates[m.id];
    const t = ev.tableCode && tables.get(ev.tableCode);
    if (t && !fromTable) {
      for (const p of t.players.values()) if (p.memberId === m.id) { p.roles = roles.slice(); say(t, `${m.name}'s powers for this game were changed`); broadcast(t); }
    }
    changed();
    return roles;
  }

  // ----- routes -----
  const routes = {
    'club/status'() { const o = state.club && state.members[state.club.ownerId]; return { exists: !!state.club, name: state.club ? state.club.name : '', needsSetupCode: !!env.SETUP_CODE, adminPin: !!(o && o.pin) }; },
    'club/adminlogin'(b) { // the admin signs back in with the 4-digit PIN alone
      const o = state.club && state.members[state.club.ownerId];
      const f = (signinFails.admin = signinFails.admin || { n: 0, until: 0 });
      if (Date.now() < f.until) throw httpErr(429, 'Too many tries. Wait a few minutes and try again.');
      let ok = false;
      if (o && o.pin) { const h = crypto.scryptSync(String(b.pin || ''), o.pin.salt, 32); ok = crypto.timingSafeEqual(h, Buffer.from(o.pin.hash, 'hex')); }
      if (!ok) { f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60000; f.n = 0; } throw httpErr(403, 'That PIN is not right'); }
      f.n = 0;
      return { mtoken: o.token };
    },
    'club/setup'(b) {
      if (state.club) throw httpErr(400, 'The club is already set up');
      if (env.SETUP_CODE && String(b.setupCode || '') !== env.SETUP_CODE) throw httpErr(403, 'Wrong setup code');
      const name = String(b.name || '').trim() ? cleanTitle(b.name) : 'Smart Buddies';
      const m = { id: rid(4), name: cleanName(b.ownerName), phone: cleanPhone(b.phone), token: rid(20), roles: [], createdAt: Date.now() };
      state.members[m.id] = m;
      state.club = { name, ownerId: m.id, createdAt: Date.now() };
      persist();
      return { mtoken: m.token };
    },
    'club/me'(b) { const m = auth(b); return viewFor(m); },
    'club/coadmin'(b) { // the admin appoints or removes a co-admin
      const o = auth(b); ownerOnly(o);
      const m = state.members[b.memberId];
      if (!m || isOwner(m)) throw httpErr(404, 'Member not found');
      m.coAdmin = !!b.on;
      for (const ev of Object.values(state.events)) {
        const t = ev.tableCode && tables.get(ev.tableCode);
        if (!t || t.ended) continue;
        for (const p of t.players.values()) if (p.memberId === m.id) { p.roles = evRoles(ev, m).slice(); say(t, m.coAdmin ? `${m.name} is now a co-admin` : `${m.name} is no longer a co-admin`); broadcast(t); }
      }
      changed();
      return { ok: true };
    },
    'club/setpin'(b) { // sign-in PIN, so a phone can sign back in with mobile + PIN
      const m = auth(b);
      const pin = String(b.pin || '');
      if (!/^\d{4,8}$/.test(pin)) throw httpErr(400, 'The PIN must be 4 to 8 digits');
      const salt = crypto.randomBytes(16).toString('hex');
      m.pin = { salt, hash: crypto.scryptSync(pin, salt, 32).toString('hex') };
      changed();
      return { ok: true };
    },
    'club/signin'(b) {
      const phone = cleanPhone(b.phone), pin = String(b.pin || '');
      const key = phone || 'none', f = (signinFails[key] = signinFails[key] || { n: 0, until: 0 });
      if (Date.now() < f.until) throw httpErr(429, 'Too many tries. Wait a few minutes and try again.');
      const m = phone && Object.values(state.members).find((x) => x.phone === phone && x.pin);
      let ok = false;
      if (m) { const h = crypto.scryptSync(pin, m.pin.salt, 32); ok = crypto.timingSafeEqual(h, Buffer.from(m.pin.hash, 'hex')); }
      if (!ok) { f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60000; f.n = 0; } throw httpErr(403, 'Mobile number or PIN is not right'); }
      f.n = 0;
      return { mtoken: m.token };
    },
    'club/profile'(b) { // a member changes their own name and phone
      const m = auth(b);
      if (b.name !== undefined && String(b.name).trim()) {
        const nm = cleanName(b.name);
        if (Object.values(state.members).some((x) => x.id !== m.id && x.name.toLowerCase() === nm.toLowerCase())) throw httpErr(400, 'Another member already uses that nickname');
        m.name = nm;
        for (const t of tables.values()) if (!t.ended) for (const p of t.players.values()) if (p.memberId === m.id && p.name !== nm) { p.name = nm; broadcast(t); }
      }
      if (b.phone !== undefined) m.phone = cleanPhone(b.phone);
      changed();
      return { ok: true };
    },
    'club/addmember'(b) {
      const o = auth(b); mgrOnly(o);
      const name = cleanName(b.name);
      if (Object.values(state.members).some((x) => x.name.toLowerCase() === name.toLowerCase())) throw httpErr(400, 'A member with that name already exists');
      const m = { id: rid(4), name, phone: cleanPhone(b.phone), token: rid(20), roles: [], createdAt: Date.now() };
      state.members[m.id] = m;
      changed();
      return { id: m.id, token: m.token };
    },
    'club/removemember'(b) {
      const o = auth(b); ownerOnly(o);
      const m = state.members[b.memberId];
      if (!m || isOwner(m)) throw httpErr(404, 'Member not found');
      delete state.members[m.id];
      for (const ev of Object.values(state.events)) { delete ev.people[m.id]; if (ev.delegates) delete ev.delegates[m.id]; if (Array.isArray(ev.invited)) ev.invited = ev.invited.filter((x) => x !== m.id); }
      const set = clients.get(m.id); if (set) { for (const res of set) { try { res.end(); } catch (e) { /* closed */ } } clients.delete(m.id); }
      changed();
      return { ok: true };
    },
    'club/resetlink'(b) {
      const o = auth(b); mgrOnly(o);
      const m = state.members[b.memberId];
      if (!m || isOwner(m)) throw httpErr(404, 'Member not found');
      m.token = rid(20);
      const set = clients.get(m.id); if (set) { for (const res of set) { try { res.end(); } catch (e) { /* closed */ } } clients.delete(m.id); }
      changed();
      return { token: m.token };
    },
    'club/setroles'(b) {
      const o = auth(b); mgrOnly(o);
      const ev = state.events[b.eventId];
      const m = state.members[b.memberId];
      if (!ev || !m || isOwner(m)) throw httpErr(404, 'Not found');
      if (ev.status === 'done') throw httpErr(400, 'That game has ended');
      return { roles: setDelegates(ev, m, b.roles) };
    },
    'club/createevent'(b) {
      const m = auth(b); mgrOnly(m);
      const startAt = b.now ? Date.now() : Math.floor(Number(b.startAt));
      if (!Number.isFinite(startAt) || startAt < Date.now() - 3600e3) throw httpErr(400, 'Pick a start time in the future');
      let invited = 'all';
      if (Array.isArray(b.invited)) invited = b.invited.filter((id) => state.members[id] && !isOwner(state.members[id]));
      const ev = {
        id: rid(4), title: String(b.title || '').trim() ? cleanTitle(b.title) : autoTitle(startAt), startAt, seats: Math.min(SEATS_MAX, Math.max(2, Math.floor(Number(b.seats)) || SEATS_MAX)),
        settings: cleanSettings({ sb: b.sb, bb: b.bb, turnSeconds: b.turnSeconds, minBuyin: b.minBuyin, maxBuyin: b.maxBuyin, sessionMinutes: b.sessionMinutes }),
        invited, auto: b.auto !== false && !(b.proposal !== false && !b.now), proposal: b.proposal !== false && !b.now, adminPlays: b.adminPlays !== false, confirmed: false, people: {}, delegates: {}, status: 'scheduled', reminded: false, tableCode: '', createdBy: m.id, createdAt: Date.now(),
      };
      let acting = null;
      if (b.actingId) { acting = state.members[b.actingId]; if (!acting || isOwner(acting)) throw httpErr(400, 'Choose a member as acting admin'); }
      if (!ev.adminPlays && !acting) throw httpErr(400, 'You are not playing, so choose a playing member as the acting admin for this game');
      if (acting && Array.isArray(ev.invited) && !ev.invited.includes(acting.id)) ev.invited.push(acting.id);
      state.events[ev.id] = ev;
      if (acting) { ev.actingId = acting.id; ev.delegates[acting.id] = ROLES.slice(); ev.people[acting.id] = { state: 'approved', at: Date.now() }; }
      changed();
      const targets = invited === 'all' ? Object.values(state.members).filter((x) => !isOwner(x)) : invited.map((id) => state.members[id]);
      for (const x of targets) {
        if (x.id === m.id) continue;
        if (acting && x.id === acting.id) { tell(x, 'allotted', `You are the acting admin and have a seat for ${inviteText(ev)}.`, { eventId: ev.id }); continue; }
        const links = baseUrl() ? `\nIN: ${rsvpLink(x, ev, 'in')}\nOUT: ${rsvpLink(x, ev, 'out')}` : '';
        tell(x, 'invite', ev.proposal ? `Proposal for a game: ${inviteText(ev)}. Smart Buddies is our private online poker portal, just for us friends. Are you available?${links}` : ev.auto ? `You are invited: ${inviteText(ev)}. Are you in or out? Seats go first come, first served.${links}` : `You are invited: ${inviteText(ev)}. Open the app and tap "I'm interested".`, { eventId: ev.id });
      }
      if (b.now) { try { openTable(ev); ev.reminded = true; persist(); } catch (e) { console.error('Could not open table', e.message); } }
      return { id: ev.id };
    },
    'club/cancelevent'(b) {
      const m = auth(b);
      const ev = state.events[b.eventId];
      if (!ev) throw httpErr(404, 'Game not found');
      if (!hasEv(m, ev, 'invite')) throw httpErr(403, 'You do not have permission to do that');
      if (ev.status === 'done') throw httpErr(400, 'That game has ended');
      ev.status = 'cancelled';
      changed();
      for (const id of approvedIds(ev)) { const x = state.members[id]; if (x) tell(x, 'cancel', `${ev.title} has been cancelled.`, { eventId: ev.id }); }
      return { ok: true };
    },
    'club/interest'(b) {
      const m = auth(b);
      const ev = state.events[b.eventId];
      if (!ev || ev.status === 'cancelled' || !canSee(ev, m)) throw httpErr(404, 'Game not found');
      if (isOwner(m)) throw httpErr(400, 'You are the admin. You are always seated.');
      const cur = ev.people[m.id];
      if (b.on && ev.proposal && ev.confirmed) { // a late reply after the group was confirmed: seat them if there is room
        const st = rsvp(m, ev, 'in');
        lateReply(m, ev, st);
        return { state: st };
      }
      if (b.on) {
        if (cur && (cur.state === 'approved' || cur.state === 'declined')) return { state: cur.state };
        ev.people[m.id] = { state: 'interested', at: Date.now() };
      } else if (cur && cur.state === 'approved') {
        delete ev.people[m.id]; // gives the seat back
        promote(ev);
      } else delete ev.people[m.id];
      changed();
      return { state: ev.people[m.id] ? ev.people[m.id].state : 'invited' };
    },
    'club/pushkey'(b) { auth(b); return { key: state.vapid.publicKey }; },
    'club/pushsub'(b) {
      const m = auth(b);
      const s = b.sub;
      if (!s || typeof s.endpoint !== 'string' || !(/^https:\/\//.test(s.endpoint) || (env.PUSH_ALLOW_HTTP && /^http:\/\/127\./.test(s.endpoint))) || !s.keys || !s.keys.p256dh || !s.keys.auth) throw httpErr(400, 'That notification setup is not valid');
      m.push = (m.push || []).filter((x) => x.endpoint !== s.endpoint);
      m.push.push({ endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) }, at: Date.now() });
      if (m.push.length > 5) m.push.splice(0, m.push.length - 5);
      persist();
      pushMember(m, { title: 'Smart Buddies', body: 'Notifications are on. You will hear about games and your turn.', tag: 'welcome', url: '/' });
      return { ok: true };
    },
    'club/pushoff'(b) {
      const m = auth(b);
      m.push = (m.push || []).filter((x) => x.endpoint !== String(b.endpoint || ''));
      persist();
      return { ok: true };
    },
    'club/backup'(b) {
      const m = auth(b); ownerOnly(m);
      return { backup: { app: 'smart-buddies', version: 1, at: Date.now(), data: { club: state.club, members: state.members, events: state.events, history: state.history || [], vapid: state.vapid } } };
    },
    'club/restore'(b) {
      const m = auth(b); ownerOnly(m);
      const d = b.backup && b.backup.app === 'smart-buddies' && b.backup.data;
      if (!d || !d.club || !d.members || !d.events || !d.members[d.club.ownerId]) throw httpErr(400, 'That is not a Smart Buddies backup');
      state = { club: d.club, members: d.members, events: d.events, history: d.history || [], vapid: d.vapid || state.vapid, tables: state.tables };
      for (const set of clients.values()) for (const res of set) { try { res.end(); } catch (e) { /* closed */ } }
      clients.clear();
      changed();
      return { ok: true, members: Object.keys(state.members).length, games: Object.keys(state.events).length };
    },
    'club/rounds'(b) { // the best rounds of one past game, fetched only when somebody opens it
      auth(b);
      const g = (state.history || []).find((x) => x.id === String(b.id || ''));
      if (!g) throw httpErr(404, 'Game not found');
      return { id: g.id, title: g.title, at: g.at, rounds: g.rounds || [] };
    },
    'club/deletegame'(b) {
      const m = auth(b); ownerOnly(m);
      if (!state.history) state.history = [];
      const i = state.history.findIndex((g) => g.id === b.id);
      if (i < 0) throw httpErr(404, 'Game not found');
      state.history.splice(i, 1);
      changed();
      return { ok: true };
    },
    'club/rsvp'(b) {
      const m = auth(b);
      const st = rsvp(m, state.events[b.eventId], b.answer === 'out' ? 'out' : 'in');
      return { state: st };
    },
    'club/confirm'(b) { // after the replies are in: seat the members who said they are available
      const m = auth(b);
      const ev = state.events[b.eventId];
      if (!ev) throw httpErr(404, 'Not found');
      if (!hasEv(m, ev, 'invite')) throw httpErr(403, 'You do not have permission to do that');
      if (ev.status === 'cancelled' || ev.status === 'done') throw httpErr(400, 'This game is closed');
      const asked = Object.keys(ev.people).filter((id) => ev.people[id].state === 'interested').sort((a, c) => ev.people[a].at - ev.people[c].at);
      let seated = 0, waiting = 0;
      for (const id of asked) {
        const x = state.members[id]; if (!x) continue;
        if (seatsLeft(ev) > 0) { ev.people[id] = { state: 'approved', at: Date.now() }; seated++; tell(x, 'allotted', `You have a seat at ${inviteText(ev)}. The admin is sending you the game link.`, { eventId: ev.id }); }
        else { ev.people[id] = { state: 'waitlist', at: Date.now() }; waiting++; }
      }
      ev.confirmed = true; ev.auto = false;
      changed();
      return { seated, waiting };
    },
    'club/decide'(b) {
      const m = auth(b);
      const ev = state.events[b.eventId];
      const target = state.members[b.memberId];
      if (!ev || !target || isOwner(target)) throw httpErr(404, 'Not found');
      if (!hasEv(m, ev, 'invite')) throw httpErr(403, 'You do not have permission to do that');
      if (ev.status === 'cancelled') throw httpErr(400, 'This game is cancelled');
      const d = String(b.decision);
      if (d === 'approve') {
        if (approvedIds(ev).length >= seatCap(ev) && !(ev.people[target.id] && ev.people[target.id].state === 'approved')) throw httpErr(400, 'The table is full');
        ev.people[target.id] = { state: 'approved', at: Date.now() };
        changed();
        tell(target, 'allotted', `Table allotted! You have a seat at ${inviteText(ev)}. Your pass is in the app.`, { eventId: ev.id });
      } else if (d === 'decline') {
        ev.people[target.id] = { state: 'declined', at: Date.now() };
        changed();
        tell(target, 'declined', `Sorry, no seat for you at ${ev.title} this time.`, { eventId: ev.id });
      } else if (d === 'reset') {
        ev.people[target.id] = { state: 'interested', at: Date.now() };
        promote(ev);
        changed();
      } else throw httpErr(400, 'Unknown decision');
      return { ok: true };
    },
    'club/enter'(b) {
      const m = auth(b);
      const ev = state.events[b.eventId];
      if (!ev || ev.status === 'cancelled') throw httpErr(404, 'Game not found');
      if (ev.status === 'done') throw httpErr(400, 'This game has ended');
      const mine = ev.people[m.id];
      if (!isOwner(m) && !(mine && mine.state === 'approved')) throw httpErr(403, 'You have not been allotted a seat at this table');
      if (!isOwner(m) && Date.now() < ev.startAt - 15 * 60e3 && !tableOpen(ev)) throw httpErr(400, 'The table opens 15 minutes before the start time');
      const t = openTable(ev);
      let p = [...t.players.values()].find((x) => x.memberId === m.id);
      if (!p) {
        p = addPlayer(t, m.name);
        p.memberId = m.id; p.roles = evRoles(ev, m).slice();
        say(t, `${m.name} sat down`);
        if (!isOwner(m) && ctx.autoBuyin && ev.auto) ctx.autoBuyin(t, p);
        broadcast(t);
      }
      return { code: t.code, token: p.token, pid: p.id };
    },
  };

  // ----- event stream for the club screen -----
  function handleEvents(req, res, url) {
    const m = memberByToken(url.searchParams.get('mtoken'));
    if (!m || !state.club) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 1500\n\n');
    if (!clients.has(m.id)) clients.set(m.id, new Set());
    clients.get(m.id).add(res);
    res.write('data: ' + JSON.stringify(viewFor(m)) + '\n\n');
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) { /* closed */ } }, 20000);
    req.on('close', () => { clearInterval(ka); const set = clients.get(m.id); if (set) { set.delete(res); if (!set.size) clients.delete(m.id); } });
  }

  // ----- reminders: one minute before start, for approved members and the admin -----
  function tick(now = Date.now()) {
    if (!state.club) return;
    for (const ev of Object.values(state.events)) {
      if (ev.status === 'cancelled' || ev.status === 'done' || ev.reminded) continue;
      const left = ev.startAt - now;
      if (left <= REMIND_MS && left > -10 * 60e3) {
        ev.reminded = true;
        try { openTable(ev); } catch (e) { console.error('Could not open table', e.message); }
        const who = approvedIds(ev).map((id) => state.members[id]).filter(Boolean);
        who.push(owner());
        for (const m of who) tell(m, 'reminder', `${ev.title} starts in about a minute. Tap Join table.`, { eventId: ev.id, startAt: ev.startAt });
        persist(); broadcastClub();
      }
    }
  }

  // called by the table: the game is over, so every delegated power ends and the pass closes
  function cancelTable(t, why) {
    const ev = t.eventId && state.events[t.eventId];
    if (!ev || ev.status === 'done' || ev.status === 'cancelled') return;
    ev.status = 'cancelled'; ev.delegates = {};
    changed();
    for (const id of approvedIds(ev)) { const x = state.members[id]; if (x) tell(x, 'cancel', `${ev.title} has been cancelled. ${why}`, { eventId: ev.id }); }
  }
  function gameEnded(t) {
    const ev = t.eventId && state.events[t.eventId];
    // keep a record of every finished game for the admin
    let historyId = null;
    if (t.final) {
      if (!state.history) state.history = [];
      historyId = rid(4);
      state.history.push({
        id: historyId, code: t.code, title: ev ? ev.title : 'Quick table', at: t.final.at, startedAt: t.createdAt, sessions: t.final.sessions, sb: t.final.sb, bb: t.final.bb,
        people: t.final.people.map((x) => ({ name: x.name, invested: x.invested, final: x.final, net: x.net, carried: x.carried || 0 })),
        transfers: t.final.transfers.map((x) => ({ from: x.fromName, to: x.toName, amount: x.amount })),
        rounds: (t.rounds || []).slice().sort((a, b) => a.no - b.no),
      });
      if (state.history.length > 300) state.history.splice(0, state.history.length - 300);
      pruneRounds();
    }
    if (!ev) { changed(); return historyId; }
    ev.delegates = {}; ev.status = 'done';
    changed();
    return historyId;
  }
  // replays are kept for the five most recent games only; the statements of older games stay for good
  function pruneRounds() {
    const withRounds = (state.history || []).filter((g) => g.rounds && g.rounds.length);
    withRounds.slice(0, Math.max(0, withRounds.length - REPLAY_GAMES)).forEach((g) => { delete g.rounds; });
  }

  // the game is over: each member with a phone gets their PDF statement on WhatsApp (needs Twilio and a public address)
  function sendStatements(t, linkFor) {
    for (const x of t.final.people) {
      const m = x.memberId && state.members[x.memberId];
      if (!m || !m.phone) continue;
      const link = linkFor(x);
      if (!/^https:/.test(link)) continue;
      const net = x.net > 0 ? 'won ' + x.net : x.net < 0 ? 'lost ' + -x.net : 'finished even';
      sendExternal(m.phone, `Smart Buddies, room ${t.code}: the game is over. You ${net}. Your account statement is attached.`, env, link)
        .catch((e) => console.error('Statement message failed:', e.message));
    }
  }
  function saveDelegates(eventId, memberId, roles) {
    const ev = state.events[eventId], m = state.members[memberId];
    if (ev && m && !isOwner(m)) setDelegates(ev, m, roles, true);
  }

  // the night turned out not to be over: take that part-way record back out
  function dropHistory(id) {
    const i = (state.history || []).findIndex((g) => g.id === id);
    if (i < 0) return false;
    state.history.splice(i, 1); changed();
    return true;
  }
  return { routes, handleEvents, load, tick, flush, setTables, getTables, pushMember, viewFor, openTable, gameEnded, dropHistory, cancelTable, sendStatements, rsvpPage, saveDelegates, state: () => state, ROLES };
}

module.exports = { createClub, fileStore, driveStore, pickStore, sendExternal, ROLES };
