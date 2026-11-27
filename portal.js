'use strict';
// Copyright (c) 2026 Vashanth Somasundaram. All rights reserved. See LICENSE.
// Who the people are, and how they get in.
//
// The portal admin is the first member. He signs in the very first time with the storage secret,
// because at that point there is nobody to have added him, and then sets a passcode like everyone
// else. Everybody he adds signs in the same way ever after: their mobile number and four digits.

const crypto = require('crypto');

const rid = (n = 10) => crypto.randomBytes(24).toString('base64url').slice(0, n);
const PIN_TRIES = 5;                    // wrong passcodes in a row before a pause
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 120);

// +91 98765 43210, 098765 43210 and 9876543210 are all the same person.
function cleanPhone(s) {
  const digits = String(s || '').replace(/\D/g, '').replace(/^0+/, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}
// A name is letters, digits, spaces, dots and hyphens, in any alphabet, and nothing else.
//
// Names are shown on other people's phones - the portal admin's above all - and a name is the
// one piece of text in the portal that somebody else chooses. Quotes, brackets and the rest have
// no business in a name and are exactly what an attack on the page showing it is made of, so they
// are taken out here, where every name, nickname and group name passes, rather than trusted to
// be handled correctly in every place one is ever displayed.
function cleanName(s) {
  return String(s || '').normalize('NFC').replace(/[^\p{L}\p{M}\p{N} .\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 18);
}
const JOIN_CODES = process.env.JOIN_CODES !== 'off';
const joinCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const isPin = (s) => /^\d{4}$/.test(String(s || ''));
// New members are made to link an authenticator. The tests of everything else switch this off.
const MUST_2FA = process.env.NEW_MEMBER_2FA !== 'off';

// Passcodes are stored as a salted hash. Four digits is not much, so the lock-out above is what
// actually protects them; the hash only means the stored file never carries the number itself.
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('base64url');
}
function setPin(m, pin) {
  m.salt = rid(12);
  m.pin = hashPin(pin, m.salt);
  m.pinSetAt = Date.now();
}
function pinOk(m, pin) {
  if (!m.pin || !m.salt) return false;
  const a = Buffer.from(m.pin);
  const b = Buffer.from(hashPin(pin, m.salt));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- the authenticator ----
// The six digits an authenticator app shows are the time, cut into half-minutes, signed with a
// secret the app and the portal both hold (RFC 6238, the scheme every such app speaks). Nothing
// is sent anywhere: the app works the number out on the phone, the portal works it out here, and
// they agree or they do not.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, acc = 0, out = '';
  for (const byte of buf) { acc = (acc << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
}
function unbase32(str) {
  let bits = 0, acc = 0; const out = [];
  for (const ch of String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '')) { acc = (acc << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((acc >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
const TOTP_STEP = 30;
function totpAt(key, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', unbase32(key)).update(msg).digest();
  const at = mac[19] & 15;
  return String(((mac.readUInt32BE(at) & 0x7fffffff) % 1000000)).padStart(6, '0');
}
// Which half-minute a code belongs to, or 0 if it is not a code for now. The half-minute either
// side is allowed, because a phone's clock is never quite the portal's and typing takes a moment.
function totpStep(key, code, now) {
  const got = String(code || '').replace(/\D/g, '');
  if (got.length !== 6 || !key) return 0;
  const here = Math.floor((now || Date.now()) / 1000 / TOTP_STEP);
  let hit = 0;
  for (const step of [here, here - 1, here + 1]) {
    const want = totpAt(key, step);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got)) && !hit) hit = step;
  }
  return hit;
}
const isCode = (s) => /^\d{6}$/.test(String(s || '').replace(/\s/g, ''));

function makePeople(ctx) {
  const { state, changed, httpErr, secret } = ctx;

  // Everybody whose record exists, and everybody who is actually in the portal. A member is one
  // of three things: waiting on the portal admin to approve the induction, in and playing, or
  // taken out. Only the middle one counts as a member for everything the portal does - signing
  // in, being told a table is up, being added up in the books.
  //
  // Taking somebody out does NOT delete them. Their games, their accounts, what they owe and what
  // they are owed all hang off their identity, and deleting the record would leave that history
  // pointing at nobody - and worse, adding the same number back later would mint a stranger with
  // the same name and an empty past. So they are archived: same record, same identity, no way in.
  const everyone = () => Object.values(state.members);
  const live = (m) => !!m && (!m.status || m.status === 'active');
  const members = () => everyone().filter(live);
  const admin = () => everyone().find((m) => m.isAdmin) || null;

  // Primary members can get a game going; secondary ones play in it. The portal admin is primary
  // whatever his record says, because somebody has to be able to open a table.
  //
  // Everybody is secondary until the portal admin says otherwise - the people already on the list
  // included. Starting a game is a thing that is given, not a thing you have unless somebody takes
  // it away, and the admin goes down the list and sets it before the portal is posted to the group.
  const tierOf = (m) => (m.isAdmin ? 'primary' : (m.tier === 'primary' ? 'primary' : 'secondary'));
  const canOpen = (m) => tierOf(m) === 'primary';
  const byPhone = (phone) => everyone().find((m) => m.phone === cleanPhone(phone)) || null;

// How many people one primary member may have in the portal at a time. Waiting to be let in
// counts, so nobody queues up fifty and leaves the portal admin a list to wade through. Somebody
// taken out, or made primary, does not - the slot is about who is here under you now, not
// everybody you have ever named.
  const INDUCT_CAP = Number(process.env.INDUCT_CAP || 10);
  const sponsored = (id) => everyone().filter((x) => x.sponsorId === id
    && (live(x) || x.status === 'pending')
    && tierOf(x) !== 'primary');
  const byId = (id) => state.members[id] || null;

  function publicMember(m) {
    const by = m.sponsorId ? state.members[m.sponsorId] : null;
    return { id: m.id, name: m.name, nick: m.nick || '', shown: m.nick || m.name,
      phone: m.phone, isAdmin: !!m.isAdmin, hasPin: !!m.pin, addedAt: m.addedAt,
      tier: tierOf(m), canOpen: canOpen(m),
      status: m.status || 'active', live: live(m),
      sponsorId: m.sponsorId || '', sponsor: by ? (by.nick || by.name) : '',
      sponsorWas: m.sponsorWas || '',          // who brought them in, when that is now history
      removedAt: m.removedAt || 0,
      twofa: !!m.totp, must2fa: !!m.must2fa };
  }

  // ---- the second step of signing in ----
  // A fresh secret, offered but not yet in force.
  function offer(m) {
    m.totpNew = base32(crypto.randomBytes(20));
    delete m.totpNewStep;
    changed();
    return { key: m.totpNew, uri: uriFor(m, m.totpNew) };
  }
  const uriFor = (m, key) => `otpauth://totp/${encodeURIComponent('Smart Buddies:' + m.name)}?secret=${key}&issuer=${encodeURIComponent('Smart Buddies')}&algorithm=SHA1&digits=6&period=30`;
  // Take a code or refuse it. A wrong one counts against him exactly as a wrong passcode does,
  // and a right one is good once: the same six digits a second time are refused, so a code read
  // over a shoulder is worth nothing.
  // (`slot` is where the last half-minute used is kept: one for the authenticator in force and
  // one for the one being linked, so that changing from one to the other inside the same
  // half-minute is not mistaken for the same code twice.)
  function useCode(m, key, code, sorry, slot) {
    const at = slot || 'totpStep';
    checkLock(m);
    const step = isCode(code) ? totpStep(key, code) : 0;
    if (!step || step <= (m[at] || 0)) { if (isCode(code)) wrongPin(m); throw httpErr(401, sorry); }
    m[at] = step;
    changed();
  }
  // the one being linked becomes the one in force
  function promote(m) {
    m.totp = m.totpNew; m.totpStep = m.totpNewStep || 0; m.totpSince = Date.now();
    delete m.totpNew; delete m.totpNewStep;
    changed();
  }
  // After the passcode: nothing more for somebody without an authenticator who does not need one;
  // a code for somebody who has one; and for somebody who must have one and has not, the linking
  // itself, there and then. Returns what to send back if he is not through yet.
  function secondStep(m, b) {
    if (m.totp) {
      // The portal admin who has lost his phone has nobody to ask, so the storage secret - which
      // only he holds - clears it, the same proof that made him admin in the first place.
      if (m.isAdmin && b.secret !== undefined) {
        if (!secret() || String(b.secret || '') !== secret()) { wrongPin(m); throw httpErr(403, 'That is not the storage secret'); }
        delete m.totp; delete m.totpNew; delete m.totpStep; delete m.totpNewStep; delete m.totpSince;
        changed();
        return null;
      }
      if (!isCode(b.code)) return { needCode: true, name: m.name, admin: !!m.isAdmin };
      useCode(m, m.totp, b.code, 'That is not the code your authenticator is showing');
      return null;
    }
    if (!m.must2fa) return null;
    if (!isCode(b.code) || !m.totpNew) {
      const o = m.totpNew ? { key: m.totpNew, uri: uriFor(m, m.totpNew) } : offer(m);
      return { setup2fa: o, name: m.name };
    }
    useCode(m, m.totpNew, b.code, 'That is not the code your authenticator is showing. Check the app and try the next one.', 'totpNewStep');
    promote(m);
    return null;
  }

  // ---- sessions: a phone stays signed in, and can be signed out from anywhere ----
  function newSession(m, label) {
    // One device at a time. Signing in here signs out wherever he was signed in before: the old
    // phone or computer is put back to the sign-in screen, and stops being sent notifications -
    // those were that device's, and this one asks for its own.
    const had = (m.sessions || []).length > 0;
    const s = { token: rid(28), at: Date.now(), until: Date.now() + SESSION_DAYS * 86400e3, label: String(label || '').slice(0, 40) };
    m.sessions = [s];
    if (had) m.subs = [];
    changed();
    if (ctx.signedOut) ctx.signedOut(m, s.token);
    return s.token;
  }
  function whoIs(token) {
    if (!token) return null;
    const t = String(token);
    for (const m of members()) {
      const s = (m.sessions || []).find((x) => x.token === t);
      if (!s) continue;
      if (s.until < Date.now()) { m.sessions = m.sessions.filter((x) => x !== s); changed(); return null; }
      return m;
    }
    return null;
  }
  function signOut(token) {
    const m = whoIs(token);
    if (!m) return;
    m.sessions = (m.sessions || []).filter((s) => s.token !== token);
    changed();
  }

  // ---- the lock-out that makes four digits safe enough ----
  //
  // Four digits is ten thousand possibilities, so everything rests on how slowly they can be
  // tried. Five wrong and a five-minute wait, for ever, came to sixty guesses an hour - a week of
  // patience - and the count was kept in memory, so every restart of the server wiped the slate
  // (and a free server restarts many times a day). Now each lock-out is longer than the last, up
  // to a day, and it is written down with the member: five minutes, half an hour, two hours,
  // then a day at a time. That is ten thousand guesses in about five years, not one week.
  const LOCKS = [5, 30, 120, 1440].map((m) => m * 60000);
  function checkLock(m) {
    const f = m.lock;
    if (f && f.until > Date.now()) {
      const mins = Math.ceil((f.until - Date.now()) / 60000);
      const wait = mins >= 120 ? `${Math.ceil(mins / 60)} hours` : `${mins} minute${mins === 1 ? '' : 's'}`;
      throw httpErr(429, `Too many wrong passcodes. Try again in ${wait}.`);
    }
  }
  function wrongPin(m) {
    const f = m.lock || { n: 0, level: 0, until: 0 };
    f.n += 1;
    if (f.n >= PIN_TRIES) {
      f.n = 0;
      f.until = Date.now() + LOCKS[Math.min(f.level, LOCKS.length - 1)];
      f.level += 1;
    }
    m.lock = f;
    changed();
  }
  const rightPin = (m) => { if (m.lock) { delete m.lock; changed(); } };

  // ---- the code a new member needs the first time ----
  //
  // Knowing somebody's mobile number is not being them. Without this, whoever signed in first
  // with a new member's number chose that member's passcode and was that member from then on -
  // and the same after any passcode was reset. So the first sign-in also needs a six-digit code
  // that travels with the invitation, is seen only by the portal admin and whoever brought the
  // member in, and stops existing the moment a passcode is set.
  function ensureJoin(m) {
    if (m.pin || !live(m)) { if (m.join) delete m.join; return ''; }
    if (!m.join) { m.join = joinCode(); changed(); }
    return m.join;
  }
  // Who may be shown it: the portal admin, and the member who brought this one in.
  function joinFor(viewer, m) {
    if (!JOIN_CODES || m.pin || !live(m)) return '';
    if (!viewer.isAdmin && m.sponsorId !== viewer.id) return '';
    return ensureJoin(m);
  }
  // Names written before names were restricted are brought into line once, when the portal starts.
  function tidy() {
    let touched = 0;
    for (const m of everyone()) {
      const n = cleanName(m.name) || 'Member';
      if (n !== m.name) { m.name = n; touched += 1; }
      if (m.nick) { const k = cleanName(m.nick); if (k !== m.nick) { m.nick = k; touched += 1; } }
      for (const g of m.groups || []) { const gn = cleanName(g.name) || 'Group'; if (gn !== g.name) { g.name = gn; touched += 1; } }
    }
    if (touched) changed();
    return touched;
  }

  return {
    members, admin, byPhone, byId, publicMember, whoIs, signOut, cleanPhone, cleanName, isPin,
    tierOf, canOpen, everyone, live, sponsored, INDUCT_CAP, joinFor, tidy,

    // Whoever is asking, or nobody.
    auth(b) {
      const m = whoIs(b && b.token);
      if (!m) throw httpErr(401, 'Please sign in again');
      return m;
    },
    adminOnly(m) {
      if (!m.isAdmin) throw httpErr(403, 'Only the portal admin can do that');
      return m;
    },

    // ---- the admin's very first sign-in ----
    // There is nobody to have added him, so he proves himself with the storage secret instead.
    firstAdmin(b) {
      if (admin()) throw httpErr(400, 'The portal already has an admin. Sign in with your mobile number.');
      if (!secret() || String(b.secret || '') !== secret()) throw httpErr(403, 'That is not the storage secret');
      const phone = cleanPhone(b.phone);
      const name = cleanName(b.name);
      if (phone.length !== 10) throw httpErr(400, 'Enter your 10-digit mobile number');
      if (!name) throw httpErr(400, 'Enter your name');
      if (!isPin(b.pin)) throw httpErr(400, 'Choose a 4-digit passcode');
      const m = { id: rid(6), name, phone, isAdmin: true, addedAt: Date.now(), sessions: [], push: [] };
      setPin(m, b.pin);
      state.members[m.id] = m;
      changed();
      return { token: newSession(m, b.device), me: publicMember(m) };
    },

    // ---- everyday sign-in: mobile number, then four digits ----
    // A member the admin has added but who has not been here before sets their passcode now.
    signIn(b) {
      const phone = cleanPhone(b.phone);
      if (phone.length !== 10) throw httpErr(400, 'Enter your 10-digit mobile number');
      const m = byPhone(phone);
      // The same answer either way, so this page cannot be used to find out who is a member - and
      // somebody waiting to be let in, or taken out, is told no in exactly the same words.
      if (!live(m)) throw httpErr(403, 'That number is not on the list. Ask the admin to add you.');
      checkLock(m);
      if (!m.pin) {
        if (!isPin(b.pin)) return { needPin: true, name: m.name, first: true };
        if (JOIN_CODES) {
          // the first admin sets the portal up with the storage secret and never comes this way
          const want = ensureJoin(m);
          const got = String(b.join || '').replace(/\D/g, '');
          const a = Buffer.from(want), c = Buffer.from(got.padEnd(want.length, 'x').slice(0, want.length));
          if (got.length !== want.length || !crypto.timingSafeEqual(a, c)) {
            wrongPin(m);
            throw httpErr(401, 'That is not the joining code in your invitation. Ask whoever invited you to send it again.');
          }
        }
        delete m.join; delete m.lock;
        setPin(m, b.pin);
        changed();
        const step = secondStep(m, b);
        return step || { token: newSession(m, b.device), me: publicMember(m), welcome: true };
      }
      if (!isPin(b.pin)) return { needPin: true, name: m.name, first: false };
      if (!pinOk(m, b.pin)) { wrongPin(m); throw httpErr(401, 'Wrong passcode'); }
      const step = secondStep(m, b);
      if (step) return step;
      rightPin(m);
      return { token: newSession(m, b.device), me: publicMember(m) };
    },

    // ---- the authenticator, from the Me page ----
    // Starting to link one. Nothing changes yet: the new secret only counts once he has typed a
    // code from it, so a link abandoned half-way leaves him exactly as he was. Replacing one that
    // is already linked takes a code from the old one first.
    totpBegin(m, b) {
      if (m.totp) useCode(m, m.totp, b.code, 'To change your authenticator, first enter a code from the one you have now');
      // The key already offered stands until it is confirmed. A phone that goes off to the
      // authenticator app and comes back has often reloaded the portal, and a new key on every
      // tap would leave the app holding one the portal has already thrown away.
      if (m.totpNew && !b.fresh) return { key: m.totpNew, uri: uriFor(m, m.totpNew) };
      return offer(m);
    },
    totpConfirm(m, b) {
      if (!m.totpNew) throw httpErr(400, 'Start again: tap Add an authenticator');
      useCode(m, m.totpNew, b.code, 'That is not the code your authenticator is showing. Check the app and try the next one.', 'totpNewStep');
      promote(m);
      return { ok: true, me: publicMember(m) };
    },
    // Taking it off again, for somebody who is free to: a member who must have one can change
    // it but not go without.
    totpOff(m, b) {
      if (!m.totp) return { ok: true, me: publicMember(m) };
      if (m.must2fa) throw httpErr(400, 'Your account needs an authenticator. You can change it, but not remove it.');
      useCode(m, m.totp, b.code, 'Enter a code from your authenticator to remove it');
      delete m.totp; delete m.totpNew; delete m.totpStep; delete m.totpNewStep; delete m.totpSince;
      changed();
      return { ok: true, me: publicMember(m) };
    },
    // The portal admin clearing somebody's, because the phone it was on is lost or changed.
    totpReset(b) {
      const m = byId(b.memberId);
      if (!m) throw httpErr(404, 'No such member');
      delete m.totp; delete m.totpNew; delete m.totpStep; delete m.totpNewStep; delete m.totpSince; delete m.lock;
      changed();
      return { ok: true, name: m.name, must: !!m.must2fa };
    },

    // Who is this number, so the sign-in screen can greet them before asking for the passcode.
    lookUp(b) {
      const m = byPhone(b.phone);
      if (!live(m)) return { known: false };
      return { known: true, name: m.name, first: !m.pin, join: JOIN_CODES && !m.pin };
    },

    changePin(m, b) {
      if (m.pin && !pinOk(m, b.old || '')) throw httpErr(401, 'That is not your current passcode');
      if (!isPin(b.pin)) throw httpErr(400, 'A passcode is four digits');
      setPin(m, b.pin);
      m.sessions = (m.sessions || []).filter((s) => s.token === b.token); // other phones sign out
      changed();
      return { ok: true };
    },

    // ---- the admin's list ----
    // Adding somebody. The portal admin's additions are in straight away; a primary member's are
    // an induction, which waits for the portal admin to approve it. Either way they come in
    // secondary - only the portal admin makes anybody primary.
    add(b, by) {
      const name = cleanName(b.name);
      const phone = cleanPhone(b.phone);
      const boss = !by || by.isAdmin;
      if (!boss && !canOpen(by)) throw httpErr(403, 'Only a primary member can bring somebody in');
      if (!name) throw httpErr(400, 'Give them a name');
      if (phone.length !== 10) throw httpErr(400, 'A 10-digit mobile number, please');

      // A number that has been here before belongs to whoever had it, even if they were taken
      // out. Minting a second record for the same person is how a history gets orphaned.
      const had = byPhone(phone);
      if (had) {
        if (live(had)) throw httpErr(400, 'That number is already on the list');
        if (had.status === 'pending') throw httpErr(400, 'That number is already waiting to be let in');
        throw httpErr(400, `${had.name} was on that number before and is in the removed list. Put ${had.name} back rather than adding the number again.`);
      }
      if (everyone().some((x) => x.name.toLowerCase() === name.toLowerCase())) throw httpErr(400, 'Somebody already goes by that name');

      if (!boss) {
        const mine = sponsored(by.id);
        if (mine.length >= INDUCT_CAP) {
          throw httpErr(400, `You have ${mine.length} people in the portal already, which is as many as anybody may bring in. One of them has to leave, or be made primary, before you can add another.`);
        }
      }

      const m = {
        id: rid(6), name, phone, addedAt: Date.now(), sessions: [], push: [], tier: 'secondary',
        must2fa: MUST_2FA,       // everybody added from now on signs in with an authenticator
        status: boss ? 'active' : 'pending',
        sponsorId: boss ? '' : by.id,
      };
      state.members[m.id] = m;
      changed();
      return publicMember(m);
    },

    // The portal admin letting an induction in, or turning it away. A declined induction is
    // archived rather than dropped, so the same number cannot be put forward again and again.
    decide(b) {
      const m = byId(b.memberId);
      if (!m) throw httpErr(404, 'No such member');
      if (m.status !== 'pending') throw httpErr(400, 'That induction has already been settled');
      if (b.ok) { m.status = 'active'; delete m.removedAt; }
      else { m.status = 'archived'; m.removedAt = Date.now(); m.declined = true; }
      changed();
      return publicMember(m);
    },
    // ---- the groups a primary member plays with ----
    // A set of people he sits down with regularly, so a table can be opened to them without
    // going round the houses. They are his: he names them, he fills them, and he is the only one
    // who opens a table to one - the portal admin aside, who sees and can use the lot.
    groups(m) {
      if (m.isAdmin) {
        return everyone().flatMap((x) => (x.groups || []).map((g) => ({ ...g, ownerId: x.id, owner: x.nick || x.name })));
      }
      return (m.groups || []).map((g) => ({ ...g, ownerId: m.id, owner: m.nick || m.name }));
    },
    findGroup(id) {
      for (const x of everyone()) {
        const g = (x.groups || []).find((y) => y.id === id);
        if (g) return { ...g, ownerId: x.id, owner: x.nick || x.name };
      }
      return null;
    },
    saveGroup(m, b) {
      if (!canOpen(m)) throw httpErr(403, 'Only a primary member can keep a group');
      const name = cleanName(b.name);
      if (!name) throw httpErr(400, 'Give the group a name');
      const ids = Array.isArray(b.members) ? b.members.filter((x) => typeof x === 'string' && state.members[x]) : [];
      const owner = b.ownerId && m.isAdmin ? state.members[b.ownerId] : m;
      if (!owner) throw httpErr(404, 'No such member');
      owner.groups = owner.groups || [];
      let g = b.id ? owner.groups.find((x) => x.id === b.id) : null;
      if (b.id && !g) throw httpErr(404, 'No such group');
      if (!g) {
        if (owner.groups.length >= 8) throw httpErr(400, 'That is as many groups as one member may keep');
        g = { id: rid(6), at: Date.now() };
        owner.groups.push(g);
      }
      g.name = name;
      // whoever keeps the group is in it, always - he is the one opening the table
      g.members = [...new Set([owner.id, ...ids])];
      changed();
      return { ...g, ownerId: owner.id, owner: owner.nick || owner.name };
    },
    removeGroup(m, b) {
      for (const x of everyone()) {
        const i = (x.groups || []).findIndex((y) => y.id === b.id);
        if (i < 0) continue;
        if (x.id !== m.id && !m.isAdmin) throw httpErr(403, 'That is not your group');
        const [gone] = x.groups.splice(i, 1);
        changed();
        return { removed: gone.id };
      }
      throw httpErr(404, 'No such group');
    },

    // Primary or secondary. The portal admin's own standing is not his to give away - if he could
    // make himself secondary there would be nobody left who could open a table.
    setTier(b) {
      const who = state.members[b.memberId];
      if (!who) throw httpErr(404, 'No such member');
      if (who.isAdmin) throw httpErr(400, 'The portal admin can always start a game');
      if (b.tier !== 'primary' && b.tier !== 'secondary') throw httpErr(400, 'Primary or secondary');
      const was = tierOf(who);
      who.tier = b.tier;

      // Somebody who stops being primary stops being answerable for the people he brought in, so
      // they come to the portal admin. Who originally brought them in is a fact and stays on the
      // record - it is just no longer a job anybody has.
      let moved = 0;
      if (was === 'primary' && b.tier === 'secondary') {
        for (const x of everyone()) {
          if (x.sponsorId !== who.id) continue;
          x.sponsorWas = x.sponsorWas || who.name;
          x.sponsorId = '';
          moved += 1;
        }
      }
      changed();
      return { ...publicMember(who), moved };
    },

    // Your own name, and the short one you go by at the table.
    rename(m, b) {
      const who = m;
      if (b.name !== undefined) {
        const name = cleanName(b.name);
        if (!name) throw httpErr(400, 'A name, please');
        if (members().some((x) => x.id !== who.id && x.name.toLowerCase() === name.toLowerCase())) {
          throw httpErr(400, 'Somebody already goes by that name');
        }
        who.name = name;
      }
      if (b.nick !== undefined) {
        const nick = cleanName(b.nick);
        if (nick && members().some((x) => x.id !== who.id && (x.nick || '').toLowerCase() === nick.toLowerCase())) {
          throw httpErr(400, 'Somebody already goes by that at the table');
        }
        who.nick = nick || '';
      }
      changed();
      return publicMember(who);
    },
    // Taking somebody out of the portal. Their record stays exactly where it is - this only shuts
    // the door. Everything that hangs off who they are stays attached to them, and letting them
    // back in is one tap rather than a new person with their name on it.
    remove(b) {
      const m = byId(b.memberId);
      if (!m) throw httpErr(404, 'No such member');
      if (m.isAdmin) throw httpErr(400, 'The portal admin stays');
      if (m.status === 'archived') return publicMember(m);
      m.status = 'archived';
      m.removedAt = Date.now();
      m.sessions = [];                     // every phone he is signed in on stops working
      changed();
      return publicMember(m);
    },

    // And letting them back in, as themselves.
    restore(b) {
      const m = byId(b.memberId);
      if (!m) throw httpErr(404, 'No such member');
      if (live(m)) return publicMember(m);
      m.status = 'active';
      delete m.removedAt;
      changed();
      return publicMember(m);
    },
    // Forget the passcode for somebody who has lost it; they set a new one next time they sign in.
    resetPin(b) {
      const m = byId(b.memberId);
      if (!m) throw httpErr(404, 'No such member');
      delete m.pin; delete m.salt; delete m.lock; delete m.join;
      m.sessions = [];
      // a fresh code goes with the fresh start: he will need it to choose the new passcode
      const join = JOIN_CODES ? ensureJoin(m) : '';
      changed();
      return { ok: true, join };
    },
  };
}

module.exports = { makePeople, cleanPhone, cleanName, isPin, totpAt, base32, unbase32 };
