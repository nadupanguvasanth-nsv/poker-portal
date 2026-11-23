'use strict';
// Where the portal keeps everything: one JSON document, either in a Google Drive file through a
// small Apps Script, or on local disk when no script is configured (which is how the tests run).
//
// Writes are coalesced. The portal asks to save far more often than anything actually changes,
// so a save that would write the same bytes as the last one is skipped, and saves are spaced out
// to stay well inside the Apps Script's daily allowance.

const fs = require('fs');
const path = require('path');

const MIN_GAP_MS = Number(process.env.SAVE_MIN_MS || 15000); // never write more often than this
const RETRIES = 3;

function driveStore(url, secret) {
  const call = async (body, tries = RETRIES) => {
    for (let i = 1; i <= tries; i++) {
      try {
        const r = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, redirect: 'follow' });
        const j = await r.json();
        if (j && j.ok) return j;
        // "busy, try again" means another save holds the lock; the others are worth reporting
        if (!j || !/busy/i.test(j.error || '')) throw new Error((j && j.error) || 'storage refused the write');
      } catch (err) {
        if (i === tries) throw err;
      }
      await new Promise((r) => setTimeout(r, 400 * i));
    }
    throw new Error('storage did not answer');
  };
  return {
    name: 'Google Drive',
    async load() {
      const r = await fetch(`${url}?key=${encodeURIComponent(secret)}`, { redirect: 'follow' });
      const j = await r.json();
      if (!j || !j.ok) throw new Error((j && j.error) || 'could not read the portal data');
      return j.value || null;
    },
    async save(value) { await call({ key: secret, action: 'set', value }); },
  };
}

function fileStore(dir) {
  const file = path.join(dir, 'portal.json');
  fs.mkdirSync(dir, { recursive: true });
  return {
    name: 'local file ' + file,
    async load() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return null; }
    },
    async save(value) {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, file);                       // never leave a half-written file behind
    },
  };
}

// The store the rest of the portal talks to: ask it to save whenever something changes and it
// works out when to actually write.
function makeStore(env = process.env) {
  const inner = env.DRIVE_SCRIPT_URL
    ? driveStore(env.DRIVE_SCRIPT_URL, env.DRIVE_SECRET || '')
    : fileStore(env.DATA_DIR || path.join(__dirname, 'data'));

  let lastJson = '';          // what we wrote last, to skip writing it again
  let lastAt = 0;
  let pending = null;         // the newest state waiting to go
  let timer = null;
  let writing = false;
  let lastError = '';

  async function flushNow() {
    if (writing || !pending) return;
    const state = pending; pending = null;
    const json = JSON.stringify(state);
    if (json === lastJson) return;                    // nothing actually changed
    writing = true;
    try {
      await inner.save(state);
      lastJson = json; lastAt = Date.now(); lastError = '';
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      pending = pending || state;                     // keep it to try again on the next tick
      console.error('Could not save:', lastError);
    } finally {
      writing = false;
    }
  }

  return {
    name: inner.name,
    load: () => inner.load(),
    // Call this as often as you like. It writes at most once every MIN_GAP_MS.
    save(state) {
      pending = state;
      if (timer) return;
      const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastAt));
      timer = setTimeout(() => { timer = null; flushNow(); }, wait);
      if (timer.unref) timer.unref();
    },
    // For shutdown and for the tests: write whatever is waiting, right now.
    async flush(state) {
      if (state) pending = state;
      if (timer) { clearTimeout(timer); timer = null; }
      await flushNow();
    },
    error: () => lastError,
  };
}

module.exports = { makeStore, driveStore, fileStore };
