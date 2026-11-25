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
      removedAt: m.removedAt || 0 };
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
    tierOf, canOpen, everyone, live, sponsored, INDUCT_CAP,

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
      if (!live(m)) return { known: false };
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
      delete m.pin; delete m.salt;
      m.sessions = [];
      fails.delete(m.id);
      changed();
      return { ok: true };
    },
  };
}

module.exports = { makePeople, cleanPhone, cleanName, isPin };
