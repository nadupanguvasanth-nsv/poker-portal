'use strict';
// Who the people are, and how they get in.
//
// The portal admin is the first member. He signs in the very first time with the storage secret,
// because at that point there is nobody to have added him, and then sets a passcode like everyone
// else. Everybody he adds signs in the same way ever after: their mobile number and four digits.

const crypto = require('crypto');

const rid = (n = 10) => crypto.randomBytes(24).toString('base64url').slice(0, n);
const PIN_TRIES = 5;                    // wrong passcodes in a row before a pause
const PIN_LOCK_MS = 5 * 60000;
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 120);
const MAX_SESSIONS = 6;                 // per member: a phone, a tablet, a reinstall or two

// +91 98765 43210, 098765 43210 and 9876543210 are all the same person.
function cleanPhone(s) {
  const digits = String(s || '').replace(/\D/g, '').replace(/^0+/, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}
function cleanName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 18);
}
const isPin = (s) => /^\d{4}$/.test(String(s || ''));

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

function makePeople(ctx) {
  const { state, changed, httpErr, secret } = ctx;

  const members = () => Object.values(state.members);
  const admin = () => members().find((m) => m.isAdmin) || null;

  // Primary members can get a game going; secondary ones play in it. The portal admin is primary
  // whatever his record says, because somebody has to be able to open a table.
  //
  // Everybody is secondary until the portal admin says otherwise - the people already on the list
  // included. Starting a game is a thing that is given, not a thing you have unless somebody takes
  // it away, and the admin goes down the list and sets it before the portal is posted to the group.
  const tierOf = (m) => (m.isAdmin ? 'primary' : (m.tier === 'primary' ? 'primary' : 'secondary'));
  const canOpen = (m) => tierOf(m) === 'primary';
  const byPhone = (phone) => members().find((m) => m.phone === cleanPhone(phone)) || null;
  const byId = (id) => state.members[id] || null;

  function publicMember(m) {
    return { id: m.id, name: m.name, nick: m.nick || '', shown: m.nick || m.name,
      phone: m.phone, isAdmin: !!m.isAdmin, hasPin: !!m.pin, addedAt: m.addedAt,
      tier: tierOf(m), canOpen: canOpen(m) };
  }

  // ---- sessions: a phone stays signed in, and can be signed out from anywhere ----
  function newSession(m, label) {
    m.sessions = (m.sessions || []).filter((s) => s.until > Date.now());
    const s = { token: rid(28), at: Date.now(), until: Date.now() + SESSION_DAYS * 86400e3, label: String(label || '').slice(0, 40) };
    m.sessions.push(s);
    if (m.sessions.length > MAX_SESSIONS) m.sessions = m.sessions.slice(-MAX_SESSIONS);
    changed();
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
  const fails = new Map();
  function checkLock(m) {
    const f = fails.get(m.id);
    if (f && f.until > Date.now()) {
      const mins = Math.ceil((f.until - Date.now()) / 60000);
      throw httpErr(429, `Too many wrong passcodes. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
  }
  function wrongPin(m) {
    const f = fails.get(m.id) || { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= PIN_TRIES) { f.n = 0; f.until = Date.now() + PIN_LOCK_MS; }
    fails.set(m.id, f);
  }
  const rightPin = (m) => fails.delete(m.id);

  return {
    members, admin, byPhone, byId, publicMember, whoIs, signOut, cleanPhone, cleanName, isPin,
    tierOf, canOpen,

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
      // The same answer either way, so this page cannot be used to find out who is a member.
      if (!m) throw httpErr(403, 'That number is not on the list. Ask the admin to add you.');
      checkLock(m);
      if (!m.pin) {
        if (!isPin(b.pin)) return { needPin: true, name: m.name, first: true };
        setPin(m, b.pin);
        changed();
        return { token: newSession(m, b.device), me: publicMember(m), welcome: true };
      }
      if (!isPin(b.pin)) return { needPin: true, name: m.name, first: false };
      if (!pinOk(m, b.pin)) { wrongPin(m); throw httpErr(401, 'Wrong passcode'); }
      rightPin(m);
      return { token: newSession(m, b.device), me: publicMember(m) };
    },

    // Who is this number, so the sign-in screen can greet them before asking for the passcode.
    lookUp(b) {
      const m = byPhone(b.phone);
      if (!m) return { known: false };
      return { known: true, name: m.name, first: !m.pin };
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
    add(b) {
      const name = cleanName(b.name);
      const phone = cleanPhone(b.phone);
      if (!name) throw httpErr(400, 'Give them a name');
      if (phone.length !== 10) throw httpErr(400, 'A 10-digit mobile number, please');
      if (byPhone(phone)) throw httpErr(400, 'That number is already on the list');
      if (members().some((x) => x.name.toLowerCase() === name.toLowerCase())) throw httpErr(400, 'Somebody already goes by that name');
      const m = { id: rid(6), name, phone, addedAt: Date.now(), sessions: [], push: [], tier: 'secondary' };
      state.members[m.id] = m;
      changed();
      return publicMember(m);
    },
    // Primary or secondary. The portal admin's own standing is not his to give away - if he could
    // make himself secondary there would be nobody left who could open a table.
    setTier(b) {
      const who = state.members[b.memberId];
      if (!who) throw httpErr(404, 'No such member');
      if (who.isAdmin) throw httpErr(400, 'The portal admin can always start a game');
      if (b.tier !== 'primary' && b.tier !== 'secondary') throw httpErr(400, 'Primary or secondary');
      who.tier = b.tier;
      changed();
      return publicMember(who);
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
    remove(b) {
      const m = byId(b.memberId);
      if (!m) throw httpErr(404, 'No such member');
      if (m.isAdmin) throw httpErr(400, 'The portal admin stays');
      delete state.members[m.id];
      changed();
      return { ok: true };
    },
    // Forget the passcode for somebody who has lost it; they set a new one next time they sign in.
    resetPin(b) {
      const m = byId(b.memberId);
      if (!m) throw httpErr(404, 'No such member');
      delete m.pin; delete m.salt;
      m.sessions = [];
      fails.delete(m.id);
      changed();
      return { ok: true };
    },
  };
}

module.exports = { makePeople, cleanPhone, cleanName, isPin };
