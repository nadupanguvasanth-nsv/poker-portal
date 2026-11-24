
// ---------------------------------------------------------------- the shape of things
// S is everything the screen knows. render() draws S. Nothing else touches the DOM.
var S = { screen: 'signin', tab: 'tables', token: '', me: null, tables: [], history: [], members: [],
          formats: [], variants: [], code: '', v: null, toast: '', busy: false, open: {}, seats: 7 };

try { S.token = localStorage.getItem('sb-token') || ''; } catch (e) {}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function fmt(n) { return (Math.round(Number(n) || 0)).toLocaleString('en-IN'); }
function kfmt(n) { n = Math.round(Number(n) || 0); return n >= 10000 ? Math.round(n / 1000) + 'k' : fmt(n); }
function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
function when(ms) { return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
function clock(ms) { return new Date(ms).toLocaleTimeString([], { timeStyle: 'short' }); }

function toast(msg, bad) { S.toast = msg; S.toastBad = !!bad; render(); clearTimeout(toast.t); toast.t = setTimeout(function () { S.toast = ''; render(); }, 3400); }
function fail(err) { toast(err && err.message ? err.message : 'Something went wrong', true); }
function blurField() { try { var a = document.activeElement; if (a && a.blur && /^(INPUT|TEXTAREA)$/.test(a.tagName)) a.blur(); } catch (e) {} }

function api(name, body) {
  return fetch('/api/' + name, { method: 'POST', body: JSON.stringify(Object.assign({ token: S.token }, body || {})) })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong'); return j; }); });
}

// ---------------------------------------------------------------- the live feed
var feed = null;
function connect() {
  if (feed) { feed.close(); feed = null; }
  if (!S.token) return;
  var url = '/api/feed?token=' + encodeURIComponent(S.token) + (S.code ? '&code=' + S.code : '');
  feed = new EventSource(url);
  feed.addEventListener('lobby', function (e) { S.tables = JSON.parse(e.data).tables; if (S.screen !== 'table') render(); });
  feed.addEventListener('table', function (e) {
    S.v = JSON.parse(e.data);
    fxIngest(S.v);          // take in anything newly thrown, once, and let it fly
    if (S.screen === 'table') render();
  });
  feed.addEventListener('ended', function () { refresh(); });
  feed.onerror = function () { /* the browser reconnects by itself */ };
}
function refresh() {
  return api('me').then(function (j) {
    S.me = j.me; S.tables = j.tables; S.history = j.history; S.members = j.members;
    S.formats = j.formats; S.variants = j.variants; S.storage = j.storage; S.saveError = j.saveError;
    S.push = j.push; clearBadge();
    if (S.screen === 'signin') S.screen = 'home';
    resumeTable();
    render();
  });
}

function doRename() {
  blurField();
  var name = val('nm_name'), nick = val('nm_nick');
  api('rename', { name: name, nick: nick }).then(function () {
    S.editName = false;
    toast('Saved');
    return refresh();
  }).catch(fail);
}

// ---------------------------------------------------------------- being told things
// A push needs the key as bytes, and it arrives as text.
function keyBytes(b64) {
  var pad = '='.repeat((4 - b64.length % 4) % 4);
  var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'cannot';
  if (!window.isSecureContext) return 'cannot';
  // on an iPhone this only works once the portal is on the home screen
  var standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  var iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (iOS && !standalone) return 'homescreen';
  if (Notification.permission === 'denied') return 'blocked';
  return (S.push && S.push.on) ? 'on' : 'off';
}

function pushOn() {
  if (!S.push || !S.push.key) return toast('The portal has no notification key yet', true);
  Notification.requestPermission().then(function (perm) {
    if (perm !== 'granted') return toast('Notifications were not allowed', true);
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription().then(function (old) {
        if (old) return old;
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(S.push.key) });
      });
    }).then(function (sub) {
      var j = sub.toJSON();
      return api('push-on', { sub: { endpoint: j.endpoint, keys: j.keys } });
    }).then(function () {
      toast('Notifications are on');
      return refresh();
    });
  }).catch(function (e) { toast(String(e && e.message || e), true); });
}

function pushOff() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (sub) { if (sub) sub.unsubscribe(); }).catch(function () {});
  }
  api('push-off', {}).then(function () { toast('Notifications are off'); return refresh(); }).catch(fail);
}

function pushTest() { api('push-test', {}).then(function () { toast('Sent - lock your phone to see it'); }).catch(fail); }

// coming back into the portal clears the number on the icon
function clearBadge() { if (navigator.clearAppBadge) { try { navigator.clearAppBadge(); } catch (e) {} } }

// An app kept on the home screen is not reloaded when you reopen it: the phone puts the page away
// and later hands it back exactly as it was, so none of the start-up code runs again. Without this
// the number would sit on the icon until the next proper sign-in, and the live feed - which does
// not survive being put away - would leave a table frozen on whatever it last showed.
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  clearBadge();
  if (!S.token) return;
  if (!feed || feed.readyState === 2) connect();
  refresh().catch(function () {});
});
window.addEventListener('pageshow', function () { clearBadge(); });

// ---------------------------------------------------------------- getting in
function askNumber() {
  blurField();
  var phone = val('in_phone');
  if (phone.replace(/\D/g, '').length < 10) { toast('Your 10-digit mobile number'); return; }
  api('look-up', { phone: phone }).then(function (j) {
    if (!j.known) { toast('That number is not on the list. Ask the admin to add you.'); return; }
    S.signin = { phone: phone, name: j.name, first: j.first };
    render();
    setTimeout(function () { var el = document.getElementById('in_pin'); if (el) el.focus(); }, 60);
  }).catch(fail);
}
function doSignIn() {
  blurField();
  var pin = val('in_pin'), again = S.signin.first ? val('in_pin2') : pin;
  if (!/^\d{4}$/.test(pin)) { toast('Four digits'); return; }
  if (pin !== again) { toast('The two passcodes are not the same'); return; }
  api('sign-in', { phone: S.signin.phone, pin: pin, device: navigator.userAgent.slice(0, 40) })
    .then(function (j) {
      S.token = j.token; try { localStorage.setItem('sb-token', j.token); } catch (e) {}
      S.signin = null;
      connect(); refresh();
      if (j.welcome) setTimeout(function () { toast('Welcome in. Add this page to your home screen.'); }, 500);
    }).catch(fail);
}
function firstAdmin() {
  blurField();
  var d = { secret: val('ad_secret'), name: val('ad_name'), phone: val('ad_phone'), pin: val('ad_pin'), device: navigator.userAgent.slice(0, 40) };
  if (d.pin !== val('ad_pin2')) { toast('The two passcodes are not the same'); return; }
  api('first-admin', d).then(function (j) {
    S.token = j.token; try { localStorage.setItem('sb-token', j.token); } catch (e) {}
    connect(); refresh();
  }).catch(fail);
}
function signOut() {
  if (!confirm('Sign out of this phone?')) return;
  api('sign-out').catch(function () {});
  S.token = ''; try { localStorage.removeItem('sb-token'); } catch (e) {}
  S.me = null; S.screen = 'signin'; S.code = ''; S.v = null;
  if (feed) { feed.close(); feed = null; }
  render();
}

function signInScreen() {
  if (S.adminSetup) {
    return '<div class="sheet"><div class="gold" style="font-size:11px;font-weight:700;letter-spacing:.18em">SMART BUDDIES</div>'
      + '<div class="disp" style="font-size:34px;line-height:1.05;margin-top:6px">Set up<br>the portal</div>'
      + '<div class="muted small" style="margin:10px 0 16px;white-space:normal">This is the first sign-in. Prove it is you with the storage secret, and you become the portal admin.</div>'
      + field('ad_secret', 'STORAGE SECRET', 'password', 'The secret in your Apps Script')
      + field('ad_name', 'YOUR NAME', 'text', 'SV')
      + field('ad_phone', 'YOUR MOBILE NUMBER', 'tel', '9876543210')
      + field('ad_pin', 'CHOOSE A 4-DIGIT PASSCODE', 'password', '', 'numeric')
      + field('ad_pin2', 'AND AGAIN', 'password', '', 'numeric')
      + '<button class="btn" style="margin-top:16px" onclick="firstAdmin()">Set up the portal</button>'
      + '<button class="btn ghost" style="margin-top:8px" onclick="S.adminSetup=false;render()">Back</button></div>';
  }
  var s = S.signin;
  return '<div class="sheet" style="padding-top:64px"><div class="gold" style="font-size:11px;font-weight:700;letter-spacing:.18em">SMART BUDDIES</div>'
    + '<div class="disp" style="font-size:38px;line-height:1;margin-top:6px">' + (s ? 'Hello ' + esc(s.name) : 'Private<br>poker party') + '</div>'
    + (s
      ? '<div class="muted small" style="margin:10px 0 16px;white-space:normal">' + (s.first ? 'First time here. Choose a 4-digit passcode and that is how you get in from now on.' : 'Your 4-digit passcode, please.') + '</div>'
        + field('in_pin', s.first ? 'CHOOSE A PASSCODE' : 'PASSCODE', 'password', '', 'numeric')
        + (s.first ? field('in_pin2', 'AND AGAIN', 'password', '', 'numeric') : '')
        + '<button class="btn" style="margin-top:16px" onclick="doSignIn()">' + (s.first ? 'Save and come in' : 'Come in') + '</button>'
        + '<button class="btn ghost" style="margin-top:8px" onclick="S.signin=null;render()">Not ' + esc(s.name) + '?</button>'
      : '<div class="muted small" style="margin:10px 0 16px;white-space:normal">Sign in with the mobile number the admin has on the list for you.</div>'
        + field('in_phone', 'MOBILE NUMBER', 'tel', '9876543210')
        + '<button class="btn" style="margin-top:16px" onclick="askNumber()">Continue</button>'
        + '<div class="muted small" style="margin-top:22px;text-align:center"><a href="#" onclick="S.adminSetup=true;render();return false" style="color:#a3aba5">Setting the portal up for the first time?</a></div>')
    + '</div>';
}
// ph is the grey hint; value fills the box with something already there to edit
function field(id, label, type, ph, mode, value) {
  return '<div class="field" style="margin-top:12px"><label for="' + id + '">' + label + '</label>'
    + '<input id="' + id + '" type="' + (type || 'text') + '"' + (mode ? ' inputmode="' + mode + '"' : '')
    + (mode === 'numeric' ? ' maxlength="4" style="letter-spacing:.5em;font-size:22px"' : '')
    + ' autocomplete="off" placeholder="' + esc(ph || '') + '"'
    + (value ? ' value="' + esc(value) + '"' : '') + '></div>';
}

// ---------------------------------------------------------------- home: tables, history, me
function home() {
  var h = '<div class="sheet" style="padding-bottom:92px">';
  h += '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">'
    + '<div><div class="gold" style="font-size:11px;font-weight:700;letter-spacing:.18em">SMART BUDDIES</div>'
    + '<div class="disp" style="font-size:32px;line-height:1">Hi, ' + esc(S.me.name) + '</div></div>'
    + (S.me.isAdmin ? '<div class="pill2 g">ADMIN</div>' : '') + '</div>';
  h += S.tab === 'tables' ? tablesTab() : S.tab === 'history' ? historyTab() : meTab();
  h += '</div><div class="tabs">'
    + tabBtn('tables', 'Tables') + tabBtn('history', 'History') + tabBtn('me', S.me.isAdmin ? 'Portal' : 'Me')
    + '</div>';
  return h;
}
function tabBtn(id, label) {
  return '<button class="' + (S.tab === id ? 'on' : '') + '" onclick="S.tab=\'' + id + '\';render()">' + label + '</button>';
}

function tablesTab() {
  var h = '';
  h += S.newTable ? newTableForm() : '<button class="btn" style="margin-top:16px" onclick="S.newTable=true;render()">Start a table</button>';
  if (!S.tables.length) h += '<div class="evc"><div class="muted small">No tables running. Start one and send the message to the group.</div></div>';
  S.tables.forEach(function (t) { h += tableCard(t); });
  return h;
}

function newTableForm() {
  var fmt = S.newFormat || 'holdem';
  var needsVariant = fmt === 'mixed' || fmt === 'roe';
  var h = '<div class="evc" style="border-color:#d8b45c"><div class="disp" style="font-size:24px">Start a table</div>';
  h += '<div class="h2" style="margin-top:12px">THE GAME</div><div style="display:flex;flex-direction:column;gap:6px">';
  S.formats.forEach(function (f) {
    h += '<button class="rolechip' + (fmt === f.id ? ' on' : '') + '" style="height:42px;text-align:left;padding:0 12px" onclick="S.newFormat=\'' + f.id + '\';render()">' + esc(f.name) + '</button>';
  });
  h += '</div>';
  if (needsVariant) {
    h += '<div class="h2">THE VARIANT TO GO WITH IT</div><div style="display:flex;flex-wrap:wrap;gap:6px">';
    S.variants.forEach(function (v) {
      h += '<button class="rolechip' + (S.newVariant === v.id ? ' on' : '') + '" onclick="S.newVariant=\'' + v.id + '\';render()">' + esc(v.name) + '</button>';
    });
    h += '</div>';
  }
  if (fmt === 'tournament') {
    h += '<div class="muted small" style="margin-top:12px;white-space:normal">Everybody starts with 10,000 chips at 50/100. The blinds double every five minutes. No late entries, nobody buys more chips, and the last player holding everything wins.</div>';
  } else {
    h += '<div class="h2">THE TABLE</div><div style="display:flex;gap:8px">'
      + miniField('n_sb', 'SMALL', S.lastSb || 100) + miniField('n_bb', 'BIG', S.lastBb || 200) + miniField('n_min', 'MIN BUY-IN', S.lastMin || 10000)
      + '</div><div style="display:flex;gap:8px;margin-top:8px">'
      + miniField('n_players', 'START WITH', 2) + miniField('n_turn', 'SECONDS A TURN', 40) + '</div>';
  }
  h += '<button class="btn" style="margin-top:14px" onclick="doOpen()">Open the table</button>'
    + '<button class="btn ghost" style="margin-top:8px" onclick="S.newTable=false;render()">Cancel</button></div>';
  return h;
}
function miniField(id, label, v) {
  return '<div class="field" style="flex:1;min-width:0"><label for="' + id + '" style="font-size:10px">' + label + '</label>'
    + '<input id="' + id + '" inputmode="numeric" value="' + v + '" style="height:44px;font-size:15px"></div>';
}
function doOpen() {
  blurField();
  var fmt = S.newFormat || 'holdem';
  if ((fmt === 'mixed' || fmt === 'roe') && !S.newVariant) { toast('Pick the variant to go with it'); return; }
  var body = { format: fmt, variant: S.newVariant };
  if (fmt !== 'tournament') {
    S.lastSb = Number(val('n_sb')); S.lastBb = Number(val('n_bb')); S.lastMin = Number(val('n_min'));
    body.settings = { sb: S.lastSb, bb: S.lastBb, minBuyin: S.lastMin, minPlayers: Number(val('n_players')), turnSeconds: Number(val('n_turn')) };
  }
  api('table-open', body).then(function (j) {
    S.newTable = false;
    S.invite = { code: j.code, text: j.invite };
    refresh();
  }).catch(fail);
}

function tableCard(t) {
  var h = '<div class="evc' + (t.iAmIn ? '" style="border-color:#d8b45c' : '') + '">';
  h += '<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">'
    + '<div style="min-width:0"><div class="disp" style="font-size:24px;line-height:1.05">' + esc(t.formatName) + '</div>'
    + '<div class="muted small">' + (t.variantName ? esc(t.variantName) + ' &middot; ' : '')
    + (t.format === 'tournament' ? 'level ' + t.level + ' &middot; ' : '') + 'blinds ' + fmt(t.blinds.sb) + '/' + fmt(t.blinds.bb) + '</div></div>'
    + '<div class="pill2' + (t.status === 'playing' ? ' g' : '') + '">' + (t.status === 'playing' ? 'PLAYING' : 'WAITING') + '</div></div>';
  h += '<div class="muted small" style="margin-top:8px;white-space:normal">Run by <b>' + esc(t.admin) + '</b> &middot; '
    + t.players + ' of ' + t.seats + ' seats' + (t.free ? ', ' + t.free + ' free' : ', full') + '</div>';
  if (t.names.length) h += '<div class="muted small" style="margin-top:2px;white-space:normal">' + t.names.map(esc).join(', ') + '</div>';
  if (t.waiting) h += '<div class="muted small" style="margin-top:6px">' + esc(t.waiting) + '</div>';
  if (t.requests && t.requests.length) {
    h += '<div class="h2" style="margin:12px 0 4px">ASKING TO COME IN</div>';
    t.requests.forEach(function (r) {
      h += '<div class="row" style="margin-top:6px"><div style="flex:1;min-width:0">' + esc(r.name) + '</div>'
        + '<button class="rolechip on" onclick="decide(\'' + t.code + '\',\'' + r.memberId + '\',true)">Let in</button>'
        + '<button class="rolechip" style="color:#d2454d;border-color:#6b2a2e" onclick="decide(\'' + t.code + '\',\'' + r.memberId + '\',false)">No</button></div>';
    });
  }
  h += '<div style="display:flex;gap:8px;margin-top:12px">';
  if (t.iAmIn) h += '<button class="btn" style="flex:1;height:46px" onclick="openTable(\'' + t.code + '\')">Open the table</button>';
  else if (t.asked) h += '<button class="btn ghost" style="flex:1;height:46px" disabled>Waiting for ' + esc(t.admin) + '</button>';
  else if (!t.free) h += '<button class="btn ghost" style="flex:1;height:46px" disabled>Full</button>';
  else h += '<button class="btn" style="flex:1;height:46px" onclick="joinTable(\'' + t.code + '\')">' + (t.status === 'playing' ? 'Ask to join' : 'Take a seat') + '</button>';
  if (t.iRunIt) h += '<button class="btn ghost" style="width:52px;height:46px;font-size:18px" title="Invite" onclick="getInvite(\'' + t.code + '\')">&#9993;</button>';
  h += '</div></div>';
  return h;
}
function joinTable(code) { api('table-join', { code: code }).then(function (j) { if (j.seated) openTable(code); else toast('Asked. The admin will let you know.'); refresh(); }).catch(fail); }
function decide(code, memberId, ok) { api('table-decide', { code: code, memberId: memberId, ok: ok }).then(function (j) { toast(j.let ? 'Let in' : 'Turned down'); refresh(); }).catch(fail); }
function getInvite(code) { api('table-invite', { code: code }).then(function (j) { S.invite = { code: code, text: j.text }; render(); }).catch(fail); }
function openTable(code) {
  S.code = code; S.screen = 'table'; S.v = null;
  try { localStorage.setItem('sb-table', code); } catch (e) {}
  connect(); render();
}
function leaveTable() {
  S.screen = 'home'; S.code = ''; S.v = null;
  try { localStorage.removeItem('sb-table'); } catch (e) {}
  connect(); render();
}

// A call comes in, the signal drops, the phone reloads the page. If you were sitting at a table
// that is still going, go straight back to it rather than making you find it again.
function resumeTable() {
  if (S.resumed || S.screen !== 'home') return;
  S.resumed = true;
  var code = '';
  try { code = localStorage.getItem('sb-table') || ''; } catch (e) {}
  if (!code) return;
  var t = (S.tables || []).filter(function (x) { return x.code === code; })[0];
  if (t && t.iAmIn && t.status !== 'ended') openTable(code);
  else try { localStorage.removeItem('sb-table'); } catch (e) {}
}

function inviteSheet() {
  var t = S.invite;
  return '<div class="sheet" style="z-index:50"><div class="disp" style="font-size:28px">' + (t.who ? 'Send this to ' + esc(t.who) : 'Send it to the group') + '</div>'
    + '<div class="muted small" style="margin:8px 0 12px;white-space:normal">' + (t.who
      ? 'This tells them where the portal is, how to keep it on their home screen, and how to sign in.'
      : 'Paste this into your WhatsApp group. Anyone on the list can open the link and take a seat.') + '</div>'
    + '<div class="evc" style="white-space:pre-wrap;font-size:13px;line-height:1.5">' + esc(t.text) + '</div>'
    + '<a class="btn" style="margin-top:14px;display:flex;align-items:center;justify-content:center;text-decoration:none" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(t.text) + '">Open WhatsApp</a>'
    + '<button class="btn ghost" style="margin-top:8px" onclick="copyText(S.invite.text)">Copy the message</button>'
    + '<button class="btn ghost" style="margin-top:8px" onclick="S.invite=null;render()">Done</button></div>';
}
function copyText(t) {
  try { navigator.clipboard.writeText(t); toast('Copied'); }
  catch (e) { var a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); toast('Copied'); }
}

// ---------------------------------------------------------------- history
function historyTab() {
  if (!S.history.length) return '<div class="evc" style="margin-top:16px"><div class="muted small">No games on record yet. They appear here when a game ends.</div></div>';
  var h = '<div class="h2">PAST GAMES</div>';
  S.history.forEach(function (g) {
    var open = S.open[g.id];
    h += '<div class="evc"><div style="cursor:pointer" onclick="S.open[\'' + g.id + '\']=!S.open[\'' + g.id + '\'];render()">'
      + '<div style="display:flex;justify-content:space-between;gap:8px"><div style="min-width:0">'
      + '<div class="disp" style="font-size:22px;line-height:1.1">' + esc(g.formatName) + (g.variantName ? ' <span class="muted" style="font-size:13px">' + esc(g.variantName) + '</span>' : '') + '</div>'
      + '<div class="muted small">' + when(g.startedAt) + ' &middot; ' + g.people.length + ' players &middot; ' + g.hands + ' hands</div></div>'
      + '<div class="muted" style="font-size:18px">' + (open ? '&#9652;' : '&#9662;') + '</div></div></div>';
    if (open) {
      if (g.winner) h += '<div class="muted small" style="margin-top:8px"><span class="gold">' + esc(g.winner) + '</span> won. ' + g.losers.map(esc).join(', ') + ' did not.</div>';
      h += '<div style="margin-top:10px">';
      g.people.slice().sort(function (a, b) { return b.net - a.net; }).forEach(function (p) {
        h += '<div class="row" style="margin-top:6px;min-height:40px"><div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600">' + esc(p.name) + '</div>'
          + '<div class="muted small">in ' + fmt(p.invested) + ' &middot; out ' + fmt(p.final) + '</div></div>'
          + '<div style="font-weight:700;color:' + (p.net > 0 ? '#7ddba0' : p.net < 0 ? '#f08a8f' : '#a3aba5') + '">' + (p.net > 0 ? '+' : '') + fmt(p.net) + '</div></div>';
      });
      h += '</div>';
      h += '<div class="h2" style="margin:12px 0 4px">WHO PAYS WHO</div>';
      if (g.transfers && g.transfers.length) {
        g.transfers.forEach(function (x) {
          h += '<div style="display:flex;justify-content:space-between;font-size:13px;margin-top:5px"><div>' + esc(x.fromName) + ' pays ' + esc(x.toName) + '</div><div class="gold" style="font-weight:700">' + fmt(x.amount) + '</div></div>';
        });
      } else {
        // it does happen: a night called off before a hand finished, or everyone exactly even
        h += '<div class="muted small" style="white-space:normal">Nobody owes anybody. Everyone finished on what they put in.</div>';
      }
      h += '<a class="btn ghost" style="margin-top:12px;display:flex;align-items:center;justify-content:center;text-decoration:none" target="_blank" rel="noopener" href="/api/statement?token=' + encodeURIComponent(S.token) + '&id=' + g.id + '">Statement (PDF)</a>';
      if (g.replays) h += '<button class="btn ghost" style="margin-top:8px" onclick="loadReplay(\'' + g.id + '\')">Best ' + g.replays + ' hands</button>';
    }
    h += '</div>';
  });
  return h;
}
function loadReplay(id) { api('replay', { id: id }).then(function (j) { S.replay = { id: id, rounds: j.rounds, i: 0 }; render(); }).catch(fail); }

// ---------------------------------------------------------------- me / portal
function meTab() {
  var h = '<div class="evc" style="margin-top:16px"><div class="muted small">SIGNED IN AS</div>'
    + '<div class="disp" style="font-size:26px">' + esc(S.me.name) + '</div>'
    + '<div class="muted small">' + esc(S.me.phone) + '</div>'
    + (S.me.nick ? '<div class="muted small" style="margin-top:2px">goes by <b>' + esc(S.me.nick) + '</b> at the table</div>' : '')
    + '<button class="btn ghost" style="margin-top:12px" onclick="S.editName=!S.editName;render()">Change my name</button>';
  if (S.editName) {
    h += field('nm_name', 'MY NAME', 'text', '', '', S.me.name)
      + field('nm_nick', 'WHAT I GO BY AT THE TABLE', 'text', 'same as my name', '', S.me.nick || '')
      + '<div class="muted small" style="margin:-4px 2px 8px;white-space:normal">Leave the second one empty to use your name. '
      + 'It sits under your seat, so keep it short.</div>'
      + '<button class="btn" onclick="doRename()">Save</button>';
  }
  h += '<button class="btn ghost" style="margin-top:8px" onclick="S.changePin=!S.changePin;render()">Change my passcode</button>';
  if (S.changePin) {
    h += field('cp_old', 'CURRENT PASSCODE', 'password', '', 'numeric') + field('cp_new', 'NEW PASSCODE', 'password', '', 'numeric')
      + '<button class="btn" style="margin-top:10px" onclick="doChangePin()">Save</button>';
  }
  h += '<button class="btn ghost" style="margin-top:8px" onclick="signOut()">Sign out of this phone</button></div>';

  // being told when a table goes up
  var ps = pushState();
  h += '<div class="h2">TELL ME WHEN A TABLE IS UP</div><div class="evc">';
  if (ps === 'on') {
    h += '<div class="muted small" style="white-space:normal">This phone will be told when somebody starts a table, '
      + 'when anyone asks to join a table you are running, and when you are let into one.</div>'
      + '<div style="display:flex;gap:8px;margin-top:10px">'
      + '<button class="btn ghost" style="flex:1" onclick="pushTest()">Send me a test</button>'
      + '<button class="btn ghost" style="flex:1" onclick="pushOff()">Turn off</button></div>';
  } else if (ps === 'off') {
    h += '<div class="muted small" style="white-space:normal">Rather than watching the group chat, let your phone tell you.</div>'
      + '<button class="btn" style="margin-top:10px" onclick="pushOn()">Turn on notifications</button>';
  } else if (ps === 'homescreen') {
    h += '<div class="muted small" style="white-space:normal">On an iPhone this works once the portal is on your home screen. '
      + 'Tap the share button in Safari, then <b>Add to Home Screen</b>, and open the portal from there.</div>';
  } else if (ps === 'blocked') {
    h += '<div class="muted small" style="white-space:normal">Your phone is refusing notifications from the portal. '
      + 'Turn them back on in your phone\'s settings, under notifications, then come back here.</div>';
  } else {
    h += '<div class="muted small" style="white-space:normal">This phone cannot take notifications from a web app.</div>';
  }
  h += '</div>';

  if (!S.me.isAdmin) return h;

  h += '<div class="h2">MEMBERS (' + S.members.length + ')</div>'
    + '<div class="muted small" style="margin:-2px 2px 8px;white-space:normal">Add somebody with their name and mobile number. They sign in with that number and set their own passcode the first time.</div>'
    + '<div class="evc"><div style="display:flex;gap:8px">'
    + '<input id="am_name" placeholder="Name" maxlength="18" style="flex:1;min-width:0;height:46px;border-radius:10px;border:1px solid #2a312d;background:#141917;color:#f2efe6;font-size:15px;padding:0 12px;font-family:inherit">'
    + '<input id="am_phone" placeholder="Mobile" inputmode="tel" style="flex:1;min-width:0;height:46px;border-radius:10px;border:1px solid #2a312d;background:#141917;color:#f2efe6;font-size:15px;padding:0 12px;font-family:inherit"></div>'
    + '<button class="btn" style="margin-top:8px;height:46px" onclick="addMember()">Add member</button></div>';
  S.members.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (m) {
    h += '<div class="row" style="margin-top:8px"><div style="flex:1;min-width:0">'
      + '<div style="font-size:14px;font-weight:600">' + esc(m.name) + (m.isAdmin ? ' <span class="gold" style="font-size:10px">ADMIN</span>' : '') + '</div>'
      + '<div class="muted small">' + esc(m.phone) + ' &middot; ' + (m.hasPin ? 'signed in before' : 'has not signed in yet') + '</div></div>'
      + (m.isAdmin ? '' : '<button class="rolechip on" onclick="memberLink(\'' + m.id + '\')">Send link</button>'
        + '<button class="rolechip" onclick="resetMember(\'' + m.id + '\',\'' + esc(m.name) + '\')">Reset passcode</button>'
        + '<button class="rolechip" style="color:#d2454d;border-color:#6b2a2e" onclick="removeMember(\'' + m.id + '\',\'' + esc(m.name) + '\')">Remove</button>') + '</div>';
  });
  h += '<div class="h2">STORAGE</div><div class="muted small">' + esc(S.storage || '') + (S.saveError ? '<br><span style="color:#f08a8f">' + esc(S.saveError) + '</span>' : '') + '</div>';
  return h;
}
function doChangePin() {
  blurField();
  api('set-pin', { old: val('cp_old'), pin: val('cp_new') }).then(function () { S.changePin = false; toast('Passcode changed. Other phones were signed out.'); render(); }).catch(fail);
}
function addMember() {
  blurField();
  api('member-add', { name: val('am_name'), phone: val('am_phone') }).then(function (m) {
    document.getElementById('am_name').value = ''; document.getElementById('am_phone').value = '';
    toast(m.name + ' added. Send them the portal link.');
    refresh();
  }).catch(fail);
}
// What a new member is sent once: where the portal lives, how to keep it, and how to get in.
function memberLink(id) {
  var m = S.members.filter(function (x) { return x.id === id; })[0];
  if (!m) return;
  var url = location.origin;
  var text = 'Hi ' + m.name + '! This is Smart Buddies, our private poker portal.\n\n' + url
    + '\n\n1. Open that on your phone.\n2. Add it to your home screen, so it opens like an app.\n'
    + '3. Sign in with this mobile number: ' + m.phone + '\n4. Choose a 4-digit passcode. That is how you get in from then on.\n\n'
    + 'After that you can see your account and past games, join a table, or start one yourself.';
  S.invite = { code: '', text: text, who: m.name };
  render();
}
function removeMember(id, name) { if (!confirm('Remove ' + name + '?')) return; api('member-remove', { memberId: id }).then(refresh).catch(fail); }
function resetMember(id, name) { if (!confirm('Forget ' + name + "'s passcode? They set a new one next time they sign in.")) return; api('member-reset', { memberId: id }).then(function () { toast('Done'); refresh(); }).catch(fail); }
