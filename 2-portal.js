
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
    // the phone's clock may be minutes out; keep the difference so the turn ring runs true
    if (S.v.now) S.skew = Date.now() - S.v.now;
    watchActs();            // did somebody just call or raise? flash it on their seat
    watchSaid();            // and has anybody said anything to you?
    watchTurn();            // and has the turn moved? ring for yours, tick for theirs
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
    S.tourney = j.tourney; S.seats = j.seats || S.seats;
    S.games = j.games || S.games; S.ranking = j.ranking || S.ranking;
    S.flags = j.flags || {}; S.toPay = j.toPay || []; S.toGet = j.toGet || []; S.flagged = j.flagged || [];
    S.adminName = j.adminName || S.adminName;
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
  var mayOpen = !S.me || S.me.canOpen !== false;
  h += S.newTable ? newTableForm()
    : (mayOpen
      ? '<button class="btn" style="margin-top:16px" onclick="S.newTable=true;render()">Start a table</button>'
      : '<div class="evc" style="margin-top:16px"><div class="muted small" style="white-space:normal">'
        + 'Any table that is up is below, and you can sit down in it. Starting one is for primary members \u2014 ask '
        + esc(S.adminName || 'the portal admin') + ' if you should be one.</div></div>')
    + '<button class="btn ghost" style="margin-top:8px" onclick="S.book=\'portal\';render()">The rule book</button>'
    + '<button class="btn ghost" style="margin-top:8px" onclick="S.book=\'games\';render()">How the games go</button>';
  if (!S.tables.length) h += '<div class="evc"><div class="muted small">No tables running. Start one and send the message to the group.</div></div>';
  S.tables.forEach(function (t) { h += tableCard(t); });
  return h;
}

function newTableForm() {
  var chosen = S.newFormat || 'holdem';
  var needsVariant = chosen === 'mixed' || chosen === 'roe';
  var h = '<div class="evc" style="border-color:#d8b45c"><div class="disp" style="font-size:24px">Start a table</div>';
  h += '<div class="h2" style="margin-top:12px">THE GAME</div><div style="display:flex;flex-direction:column;gap:6px">';
  S.formats.forEach(function (f) {
    h += '<button class="rolechip' + (chosen === f.id ? ' on' : '') + '" style="height:42px;text-align:left;padding:0 12px" onclick="S.newFormat=\'' + f.id + '\';render()">' + esc(f.name) + '</button>';
  });
  h += '</div>';
  if (needsVariant) {
    h += '<div class="h2">THE VARIANT TO GO WITH IT</div><div style="display:flex;flex-wrap:wrap;gap:6px">';
    S.variants.forEach(function (v) {
      h += '<button class="rolechip' + (S.newVariant === v.id ? ' on' : '') + '" onclick="S.newVariant=\'' + v.id + '\';render()">' + esc(v.name) + '</button>';
    });
    h += '</div>';
  }
  if (chosen === 'tournament') {
    h += '<div class="h2">THE TOURNAMENT</div><div style="display:flex;gap:8px">'
      + miniField('n_stack', 'CHIPS EACH', S.lastStack || 10000, 'oninput="tourneyEcho()" onblur="tourneySnap()"')
      + miniField('n_level', 'MINUTES A LEVEL', S.lastLevel || 5, 'oninput="tourneyEcho()" onblur="tourneySnap()"')
      + '</div><div class="muted small" id="t_echo" style="margin-top:8px;white-space:normal">' + tourneyLine(S.lastStack || 10000, S.lastLevel || 5) + '</div>'
      + '<div class="muted small" style="margin-top:8px;white-space:normal">Chips go in tens of thousands &mdash; 10,000, 20,000, 50,000 and so on. Anything in between is taken to the nearest. No late entries, nobody buys more chips, and the last player holding everything wins.</div>';
  } else {
    h += '<div class="h2">THE TABLE</div><div style="display:flex;gap:8px">'
      + miniField('n_sb', 'SMALL', S.lastSb || 100) + miniField('n_bb', 'BIG', S.lastBb || 200) + miniField('n_min', 'MIN BUY-IN', S.lastMin || 10000)
      + '</div><div style="display:flex;gap:8px;margin-top:8px">'
      + miniField('n_players', 'START WITH', 4) + miniField('n_turn', 'SECONDS A TURN', 40) + '</div>'
      + '<div style="display:flex;gap:8px;margin-top:8px">'
      + miniField('n_stay', 'MINUTES EACH', S.lastStay === undefined ? 60 : S.lastStay) + '<div style="flex:1"></div></div>'
      + '<div class="muted small" style="margin-top:6px;white-space:normal">How long everybody is expected to stay once they sit down, so the game does not fall apart the moment somebody is ahead. Anyone who has lost the lot may always go, and you can let somebody go early. 0 for no minimum.</div>';
  }
  h += '<button class="btn" style="margin-top:14px" onclick="doOpen()">Open the table</button>'
    + '<button class="btn ghost" style="margin-top:8px" onclick="S.newTable=false;render()">Cancel</button></div>';
  return h;
}
function miniField(id, label, v, attrs) {
  return '<div class="field" style="flex:1;min-width:0"><label for="' + id + '" style="font-size:10px">' + label + '</label>'
    + '<input id="' + id + '" inputmode="numeric" value="' + v + '" ' + (attrs || '')
    + ' style="height:44px;font-size:15px"></div>';
}

// The chips everyone starts with go in tens of thousands, and the blinds follow from them: two
// hundred big blinds each, which comes out whole and round every time. The admin is shown what a
// figure works out to as he types it, so he is never surprised by the first hand.
function tStack(v) {
  var t = S.tourney || {}, step = t.step || 10000;
  var n = Number(v);
  if (!isFinite(n) || n <= 0) return t.stack || 10000;
  var snapped = Math.round(n / step) * step;
  return Math.min(t.maxStack || 10000000, Math.max(t.minStack || 10000, snapped));
}
function tLevel(v) {
  var t = S.tourney || {}, n = Math.floor(Number(v));
  if (!isFinite(n)) return 5;
  return Math.min(t.maxLevelMin || 60, Math.max(t.minLevelMin || 2, n));
}
function tourneyLine(stack, level) {
  var sb = stack / 400, bb = stack / 200;
  return 'Everybody starts with ' + fmt(stack) + ' chips at ' + fmt(sb) + '/' + fmt(bb)
    + ' &mdash; 200 big blinds each. The blinds double every '
    + (level === 1 ? 'minute' : level + ' minutes') + '.';
}
// As he types. The figures are snapped here too, so what he reads is what he will get.
function tourneyEcho() {
  var el = document.getElementById('t_echo');
  if (el) el.innerHTML = tourneyLine(tStack(val('n_stack')), tLevel(val('n_level')));
}
// Leaving the box puts the snapped figure into it, so nothing says 17,000 while the table is 20,000.
function tourneySnap() {
  var a = document.getElementById('n_stack'), b = document.getElementById('n_level');
  if (a) a.value = tStack(a.value);
  if (b) b.value = tLevel(b.value);
  tourneyEcho();
}
function doOpen() {
  blurField();
  var chosen = S.newFormat || 'holdem';
  if ((chosen === 'mixed' || chosen === 'roe') && !S.newVariant) { toast('Pick the variant to go with it'); return; }
  var body = { format: chosen, variant: S.newVariant };
  if (chosen === 'tournament') {
    S.lastStack = tStack(val('n_stack'));
    S.lastLevel = tLevel(val('n_level'));
    body.settings = { stack: S.lastStack, levelMin: S.lastLevel };
  } else {
    S.lastSb = Number(val('n_sb')); S.lastBb = Number(val('n_bb')); S.lastMin = Number(val('n_min'));
    S.lastStay = Math.max(0, Math.floor(Number(val('n_stay'))) || 0);
    body.settings = { sb: S.lastSb, bb: S.lastBb, minBuyin: S.lastMin, minPlayers: Number(val('n_players')),
      turnSeconds: Number(val('n_turn')), minMinutes: S.lastStay };
  }
  api('table-open', body).then(function (j) {
    S.newTable = false;
    S.invite = { code: j.code, text: j.invite };
    refresh();
  }).catch(fail);
}

// How each game is played, written out of the same specification the dealer deals by. Nobody has
// to take this on trust or keep it up to date: if a game is ever changed, this changes with it.
function generalBook() {
  var h = '<div class="sheet" style="z-index:55">'
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">'
    + '<div><div class="disp" style="font-size:28px;line-height:1.05">The rule book</div>'
    + '<div class="muted small">How a night works, whatever is being dealt</div></div>'
    + '<button class="rolechip" onclick="S.book=false;render()">Close</button></div>';
  var part = function (title, bits) {
    h += '<div class="evc" style="margin-top:12px"><div class="disp" style="font-size:22px;line-height:1.1">' + title + '</div><div style="margin-top:8px">';
    bits.forEach(function (b) {
      h += '<div style="display:flex;gap:8px;margin-top:5px"><div class="gold" style="flex:none">&middot;</div>'
        + '<div class="muted small" style="white-space:normal">' + b + '</div></div>';
    });
    h += '</div></div>';
  };

  part('Getting a game going', [
    'A primary member can start a table, and whoever starts it runs it. Several can run at once. Everybody else plays in them - the portal admin decides who is which, and tells you if he changes yours.',
    'Starting one gives you a message to paste into the group chat.',
    'Before play, take a free seat from the list. The table deals itself once enough of you are sitting down with chips - nobody presses anything, and it says so a few seconds before it does.',
    'If somebody stands up again before it deals, it stops and says why rather than going quiet.',
    'Arrive after it has started and you ask to come in; whoever runs the table lets you in or does not.',
    'You can watch a running game without taking a seat, and be offered one from inside the room.',
  ]);

  part('At the table', [
    'Seven seats, first come first served.',
    'Nothing waits on a tap that never comes: run out of time on your turn and you check if you can, fold if you cannot, and sit out until you say otherwise.',
    'However long a table asks you to stay, your time runs from when <b>you</b> sat down, not from when the game began.',
    'Three ways out before your time is up: you have lost the lot, whoever runs the table lets you go, or you sit in the ring paying your blinds - posted and folded, never dealt - until your time is up.',
    'Chips bought while a hand is being played go on when that hand ends, never in the middle of it.',
    'If somebody is all-in for less than the bets around him, the rest goes into a side pot that only the players who paid into it can win. He can win no more than he put in, matched by everybody still in the hand.',
    'Showing your cards can be chosen at any point in a hand, but only happens once the hand is over.',
    'A hand nobody folded is settled by the cards. A pot four times the usual, quads or a straight flush puts fireworks over the table.',
  ]);

  part('Saying something', [
    'Nobody types at a table. There is a list of things worth saying and you tap one - back in five minutes, deal me out, one more orbit, nice hand, I need to leave early.',
    'It lands at the bottom of the other person\u2019s screen for five seconds and then goes.',
    'Some of them do the thing as well as say it: asking to leave early raises the real request, and buying back in, sitting out and coming back happen on the tap.',
    'Whoever runs the table has his own list - starting in a minute, your turn, taking a break, wrapping up, please settle up.',
  ]);

  part('When the game ends', [
    'Whoever runs the table closes it, and a hand in progress is always played out first.',
    'He can also call the last five or ten hands, or set a time to finish, at any point during the game.',
    'Everybody\u2019s stack is rounded off and whatever the rounding makes or loses goes onto the biggest stack, so the books tally to the chip.',
    'The portal pairs the biggest loser with the biggest winner until everybody is square - fewer payments than everyone paying everyone.',
    'The night is filed with the date and time. You see the games you played in, with your own account, the chips hand by hand, and your running total across every game.',
    'A game where no hand was ever dealt leaves no record: everybody still holds what they bought in with.',
  ]);

  part('Settling up', [
    'A debt is settled when the person owed confirms the money arrived - not when the payer says he has sent it. You can say you have paid and it is recorded, but it is your word, not a receipt.',
    'If the money has gone and he has not marked it, chasing him is your job.',
    'Leave one unpaid long enough and you are flagged yellow: you can still play if whoever runs the table lets you in, and it clears itself the moment the winner confirms. Nobody has to lift it.',
    'Carry several yellows at once, or leave one much longer, and it turns red. Red keeps you out of the table altogether, playing or watching.',
    'Only the portal admin lifts a red flag, and paying up does not lift it by itself.',
    'If a winner cannot be reached, the portal admin can enter the receipt for him - and it is recorded as exactly that.',
    'Chips are virtual. What you settle between yourselves, and how, is your own business.',
  ]);

  part('Where the numbers are', [
    'This book is the same whatever is being dealt. The buy-in, the blinds, the time to act, how many it takes to start, how long you are expected to stay and the exact hours on the flags belong to a particular table.',
    'Every table carries its own sheet with its own figures: the (i) beside it in the list, or House rules in the table menu. Those are read from the game as it is being played, so they cannot drift.',
    'What each game deals, which of your cards play, and what beats what are in How the games go.',
  ]);

  return h + '<button class="btn ghost" style="margin-top:16px" onclick="S.book=false;render()">Back</button></div>';
}

function gameBook() {
  var games = S.games || [];
  var h = '<div class="sheet" style="z-index:55">'
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">'
    + '<div><div class="disp" style="font-size:28px;line-height:1.05">How the games go</div>'
    + '<div class="muted small">Every game the portal deals, and what beats what</div></div>'
    + '<button class="rolechip" onclick="S.book=false;render()">Close</button></div>';

  games.forEach(function (g) {
    h += '<div class="evc" style="margin-top:12px"><div class="disp" style="font-size:22px;line-height:1.1">' + esc(g.name) + '</div>';
    var bits = [];
    bits.push(g.hole + ' card' + (g.hole === 1 ? '' : 's') + ' to each player, face down');
    if (g.omaha) {
      bits.push(g.hole === 2
        ? 'Both of your cards play, with three from the board'
        : 'Exactly two of your cards play, with three from the board \u2014 no more, no fewer');
      // the hand people argue about: exactly two from hand cuts both ways
      bits.push('So one in your hand with three on the board <b>is</b> four of a kind \u2014 your card and one other, with the three from the board. A pair in your hand with two on the board is four of a kind too.');
      bits.push('But four of a kind lying on the board is only three of a kind to you: you may take three board cards and no more, so the fourth is out of reach and two of your own have to come with it. The same board in Texas would be quads for everybody.');
    } else {
      bits.push('Make the best five from your two and the board, in any combination \u2014 both, one, or neither');
    }
    if (g.boards > 2) {
      bits.push(g.boards + ' separate boards are dealt, each scored on its own');
      bits.push('Every board you win is worth a point, and a board you split is worth a share of one. The most points takes the <b>whole</b> pot \u2014 so you need to be good on two of the three. Win one board while somebody else wins the other two and you get nothing.');
      bits.push('Level on points and the pot is split equally between those who are level \u2014 three players winning a board each take a third apiece');
      bits.push('If somebody is all-in for less, the points are counted again for the side pot among only the players who paid into it. His cards have no claim on money he did not put in, and a board he would have won goes to the best of the rest.');
    } else if (g.boards > 1) {
      bits.push(g.boards + ' separate boards are dealt, each scored on its own, and the pot is split between them \u2014 win one board and you take half, win both and you take the lot');
    }
    else bits.push('One board: three cards, then one, then one');
    if (g.bomb) bits.push('Everybody antes before the deal and there is no betting before the flop \u2014 the hand starts there');
    else bits.push('Betting before the flop, and after each card that follows');
    bits.push(g.pl
      ? 'Pot-limit: raise anything you like between the minimum and the pot \u2014 and a pot raise means your call first, then the pot as it stands after that call, so with 300 in the middle and 200 to call it comes to 700. The \u00bd pot and \u00be pot buttons work out the amounts for you.'
      : 'No-limit: raise anything from the minimum up to every chip you have');
    bits.push('Up to ' + Math.min(g.max, S.seats || 7) + ' players in a hand');
    h += '<div style="margin-top:8px">';
    bits.forEach(function (b) {
      h += '<div style="display:flex;gap:8px;margin-top:5px"><div class="gold" style="flex:none">&middot;</div>'
        + '<div class="muted small" style="white-space:normal">' + b + '</div></div>';
    });
    h += '</div></div>';
  });

  var rank = S.ranking || [];
  if (rank.length) {
    h += '<div class="h2" style="margin-top:16px">WHAT BEATS WHAT</div><div class="evc">'
      + '<div class="muted small" style="white-space:normal;margin-bottom:4px">Best first. Every game here is scored the same way.</div>';
    rank.forEach(function (r, i) {
      h += '<div style="padding:5px 0;border-top:1px solid #1d2420;font-size:13px;font-weight:600">' + (i + 1) + '. ' + esc(r) + '</div>';
    });
    h += '</div><div class="muted small" style="white-space:normal;margin-top:8px">A royal flush is the ace-high straight flush - the same hand, and the best there is. Two hands of the same kind are settled by the cards in them, highest first. Still level, and the pot is split.</div>';
  }
  return h + '<button class="btn ghost" style="margin-top:16px" onclick="S.book=false;render()">Back</button></div>';
}

// The rules of a table, written out of the table's own settings rather than typed somewhere and
// left to go stale. Everything here is a real number the game is being played on.
function rulesSheet() {
  var t = (S.tables || []).filter(function (x) { return x.code === S.rules; })[0];
  if (!t) return '<div class="sheet"><div class="muted">That table has gone.</div>'
    + '<button class="btn ghost" style="margin-top:14px" onclick="S.rules=null;render()">Back</button></div>';

  var tourney = t.format === 'tournament';
  var row = function (k, v) {
    return '<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid #1d2420">'
      + '<div class="muted small" style="flex:none">' + k + '</div>'
      + '<div style="font-size:13px;text-align:right;font-weight:600">' + v + '</div></div>';
  };
  var note = function (txt) { return '<div class="muted small" style="white-space:normal;margin-top:6px">' + txt + '</div>'; };
  // The portal's own figures travel with the table, so this sheet states what the server is
  // actually enforcing tonight rather than what somebody typed in here once.
  var H = t.house || { graceSeconds: 6, roundTo: 50, yellowHours: 48, redHours: 96, redAtDebts: 3 };

  var h = '<div class="sheet" style="z-index:55">'
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">'
    + '<div><div class="disp" style="font-size:28px;line-height:1.05">House rules</div>'
    + '<div class="muted small">' + esc(t.formatName) + (t.variantName ? ' &middot; ' + esc(t.variantName) : '') + ' &middot; table ' + esc(t.code) + '</div></div>'
    + '<button class="rolechip" onclick="S.rules=null;render()">Close</button></div>';

  h += '<div class="h2">THE MONEY</div>';
  if (tourney) {
    h += row('Everybody starts with', fmt(t.minBuyin) + ' chips')
      + row('Blinds', fmt(t.blinds.sb) + ' / ' + fmt(t.blinds.bb) + ' at level 1')
      + row('Buying more', 'Nobody does');
    h += note('A tournament gives everyone the same chips. The blinds double as the night goes on, nobody joins late and nobody buys more. The last player holding the lot wins.');
  } else {
    h += row('Buy in for', t.maxBuyin >= 1e9 ? fmt(t.minBuyin) + ' or more' : fmt(t.minBuyin) + ' to ' + fmt(t.maxBuyin))
      + row('Blinds', fmt(t.blinds.sb) + ' / ' + fmt(t.blinds.bb))
      + row('Buying more', 'Any time');
    h += note('Chips bought while a hand is being played go on when that hand ends, never in the middle of it. You can also ask to be bought back in automatically: run out, and ' + fmt(t.minBuyin) + ' goes on at the end of that hand. Until you have chips you are dealt out.');
  }

  h += '<div class="h2">STAYING AND LEAVING</div>';
  h += row('Expected to stay', t.minMinutes ? t.minMinutes + ' minutes' : 'As long as you like');
  if (t.minMinutes) {
    h += note('Your ' + t.minMinutes + ' minutes run from when you sat down, not from when the game began, so arriving late does not mean leaving early. Three ways out before your time is up: you have lost the lot, ' + esc(t.admin) + ' lets you go, or you sit in the ring paying your blinds - posted and folded, never dealt - until your time is up and then leave with what is left. After that nobody has to ask anybody.');
  } else {
    h += note('Nobody has to ask to leave at this table.');
  }

  h += '<div class="h2">THE PLAY</div>';
  h += row('Seats', t.seats + ', first come first served')
    + row('Deals itself at', t.minPlayers + ' players')
    + row('Time to act', t.turnSeconds + ' seconds');
  h += note('Nobody has to press anything to begin. Once ' + t.minPlayers + ' of you are sitting down with chips the table says so and deals '
    + (H.graceSeconds ? H.graceSeconds + ' seconds later' : 'straight away')
    + ' - and if somebody stands up again before then it stops and says why. '
    + esc(t.admin) + ' can deal early, or go short-handed, from the table menu. Anyone arriving after that asks to come in.');
  if (t.lastHands) h += row('Still to play', t.lastHands + ' hand' + (t.lastHands === 1 ? '' : 's'));
  if (t.endAt) h += row('Finishing at', clock(t.endAt));
  h += note('Run out of time on your turn and you check if you can, fold if you cannot, and sit out until you say otherwise. Nothing ever waits on a tap that never comes.');
  if (t.format === 'mixed') h += note('The variant comes round on its own button, travelling the other way: when the deal reaches the seat holding it, that hand is ' + esc(t.variantName) + '.');
  if (t.format === 'roe') h += note('A full orbit of Texas, then a full orbit of ' + esc(t.variantName) + ', turn and turn about.');
  if (t.bombAnteBB && /bomb/i.test(t.variantName || '')) h += note('In a bomb pot everybody antes ' + t.bombAnteBB + ' big blinds and the hand starts on the flop.');

  h += '<div class="h2">SAYING SOMETHING</div>';
  h += row('How', 'Tap it, do not type it');
  h += note('There is a list of things worth saying at a table and you tap one - back in five minutes, deal me out, one more orbit, nice hand, I need to leave early. It lands at the bottom of the other person\u2019s screen for five seconds and then goes. Some of them do the thing as well as say it: asking to leave early raises the real request with ' + esc(t.admin) + ', and buying back in, sitting out and coming back happen on the tap. ' + esc(t.admin) + ' has his own list - starting in a minute, your turn, taking a break, wrapping up, please settle up.');

  h += '<div class="h2">SETTLING UP</div>';
  h += row('Stacks rounded to', fmt(H.roundTo) + ' chips');
  h += row('Who pays who', 'Biggest loser to biggest winner');
  h += row('Settled when', 'The winner says it arrived');
  h += row('Yellow flag at', H.yellowHours + ' hours unpaid');
  h += row('Red flag at', H.redHours + ' hours, or ' + H.redAtDebts + ' yellows');
  h += note('When the game closes, everybody\u2019s stack is rounded to the nearest ' + fmt(H.roundTo) + ' and whatever the rounding makes or loses goes onto the biggest stack, so the books tally to the chip. The portal then pairs the biggest loser with the biggest winner until everybody is square, which is fewer payments than everyone paying everyone.');
  h += note('A debt is settled when the person owed confirms the money arrived, and not before. You can say you have paid and it is recorded, but it is your word, not a receipt - if the money has gone and he has not marked it, chasing him is your job.');
  h += note('Leave it ' + H.yellowHours + ' hours and you are flagged yellow: you can still play if ' + esc(t.admin) + ' lets you in, and the flag clears itself the moment the winner confirms - nobody has to lift it. ' + H.redAtDebts + ' yellows at once, or ' + H.redHours + ' hours on any one of them, turns it red. Red keeps you out of the table altogether, playing or watching, only the portal admin lifts it, and paying up does not lift it by itself.');

  h += '<div class="h2">WHO RUNS IT</div>';
  h += row('This table', esc(t.admin));
  h += note(esc(t.admin) + ' lets latecomers in, decides who may leave early, can stop the game for a break, call the last few hands or set a time to finish, and closes it at the end. Closing works out everyone\u2019s account and says who pays who. The portal admin can do all of that too.');

  return h + '<button class="btn ghost" style="margin-top:16px" onclick="S.rules=null;render()">Back</button></div>';
}

function tableCard(t) {
  var h = '<div class="evc' + (t.iAmIn ? '" style="border-color:#d8b45c' : '') + '">';
  h += '<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">'
    + '<div style="min-width:0"><div class="disp" style="font-size:24px;line-height:1.05">' + esc(t.formatName) + '</div>'
    + '<div class="muted small">' + (t.variantName ? esc(t.variantName) + ' &middot; ' : '')
    + (t.format === 'tournament' ? 'level ' + t.level + ' &middot; ' : '') + 'blinds ' + fmt(t.blinds.sb) + '/' + fmt(t.blinds.bb) + '</div></div>'
    + '<div class="pill2' + (t.paused ? '' : t.status === 'playing' ? ' g' : '') + '">' + (t.paused ? 'PAUSED' : t.status === 'playing' ? 'PLAYING' : 'WAITING') + '</div></div>';
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
  // You do not have to commit to a seat to come in and look. Walk into the room, watch a hand,
  // and sit down when you feel like it - the table screen offers the seat once you are there.
  if (!t.iAmIn && t.status !== 'ended') {
    h += '<button class="btn ghost" style="width:86px;height:46px;font-size:13px" onclick="openTable(\'' + t.code + '\')">Watch</button>';
  }
  h += '<button class="btn ghost" style="width:52px;height:46px;font-size:17px" title="House rules" onclick="S.rules=\'' + t.code + '\';render()">&#9432;</button>';
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
      : t.group
        ? 'Paste this into your WhatsApp group. It names whoever you have set to primary right now, so set them before you send it.'
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
// What a game can be found by: what was played, who played it, and when. The date is matched
// against the way it is printed on the card, so looking for "24 Nov" finds what you can see.
function historyMatch(g, q) {
  if (!q) return true;
  q = q.toLowerCase();
  var hay = [g.formatName, g.variantName, g.title, when(g.startedAt), g.winner || '']
    .concat((g.people || []).map(function (p) { return p.name; })).join(' ').toLowerCase();
  return hay.indexOf(q) >= 0;
}
function historyInRange(g) {
  var at = g.startedAt || g.at;
  if (S.hFrom) { var f = new Date(S.hFrom); f.setHours(0, 0, 0, 0); if (at < f.getTime()) return false; }
  if (S.hTo) { var t = new Date(S.hTo); t.setHours(23, 59, 59, 999); if (at > t.getTime()) return false; }
  return true;
}
function historyShown() {
  return S.history.filter(function (g) { return historyMatch(g, S.hq || '') && historyInRange(g); });
}
// The whole screen is never redrawn while somebody is typing in it - that is what keeps the
// caret where they put it - so searching replaces only the list of games underneath. A full
// render() here would either be refused by that guard, leaving a stale list, or would take the
// search box away mid-word.
function historyPaint() {
  var el = document.getElementById('hlist');
  if (el) el.innerHTML = historyList();
  var n = document.getElementById('hcount');
  if (n) n.innerHTML = historyCount();
  var b = document.getElementById('hbooks');
  if (b) b.innerHTML = theBooks();
}
function historySearch() { S.hq = val('cp_hq'); historyPaint(); }
function historyDates() {
  var f = document.getElementById('cp_from'), t = document.getElementById('cp_to');
  S.hFrom = f ? f.value : ''; S.hTo = t ? t.value : '';
  historyPaint();
}
function historyClear() { S.hq = ''; S.hFrom = ''; S.hTo = ''; render(); }
// Only the id travels through the markup. Putting the game's name in there instead looked
// tidier right up until "Texas Hold'em" - the apostrophe comes back out of the attribute as a
// quote and ends the string early, taking the rest of the handler with it.
function removeGame(id) {
  var g = S.history.filter(function (x) { return x.id === id; })[0];
  if (!g) return;
  S.ask = {
    title: 'Remove this game?',
    detail: g.formatName + ' on ' + when(g.startedAt)
      + ' goes from the records for everybody who played in it, along with its accounts and replays. This cannot be undone.',
    yes: 'Yes, remove it',
    go: "doRemoveGame('" + id + "')",
  };
  render();
}
function doRemoveGame(id) {
  S.ask = null;
  api('history-remove', { id: id }).then(function () { toast('Removed'); return refresh(); }).catch(fail);
}

function historyCount() {
  var all = S.history.length, shown = historyShown().length;
  if (!(S.hq || S.hFrom || S.hTo)) return '';
  return '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">'
    + '<div class="muted small">' + shown + ' of ' + all + ' game' + (all === 1 ? '' : 's') + '</div>'
    + '<button class="rolechip" onclick="historyClear()">Clear</button></div>';
}
function historyTab() {
  if (!S.history.length) return '<div class="evc" style="margin-top:16px"><div class="muted small">No games on record yet. They appear here when a game ends.</div></div>';
  var h = '<div class="h2">PAST GAMES</div>'
    + '<div class="muted small" style="margin:-2px 2px 8px;white-space:normal">'
    + (S.me && S.me.isAdmin ? 'Every game in the portal. Search by game, by a player\u2019s name, or by the dates.'
                            : 'The games you played in. Search by game, by who was at the table, or by the dates.')
    + '</div>';
  h += '<div class="evc"><div style="display:flex;gap:8px">'
    + '<input id="cp_hq" placeholder="Texas, Omaha, a name&hellip;" value="' + esc(S.hq || '') + '" oninput="historySearch()" '
    + 'style="flex:1;min-width:0;height:44px;border-radius:10px;border:1px solid #2a312d;background:#141917;color:#f2efe6;font-size:15px;padding:0 12px;font-family:inherit"></div>'
    + '<div style="display:flex;gap:8px;align-items:center;margin-top:8px">'
    + '<input id="cp_from" type="date" value="' + esc(S.hFrom || '') + '" onchange="historyDates()" style="flex:1;min-width:0;height:40px;border-radius:10px;border:1px solid #2a312d;background:#141917;color:#f2efe6;font-size:13px;padding:0 10px;font-family:inherit">'
    + '<span class="muted small">to</span>'
    + '<input id="cp_to" type="date" value="' + esc(S.hTo || '') + '" onchange="historyDates()" style="flex:1;min-width:0;height:40px;border-radius:10px;border:1px solid #2a312d;background:#141917;color:#f2efe6;font-size:13px;padding:0 10px;font-family:inherit"></div>'
    + '<div id="hcount">' + historyCount() + '</div>'
    + '</div>';
  return h + '<div id="hbooks">' + theBooks() + '</div><div id="hlist">' + historyList() + '</div>';
}

// Everything the portal knows about who is up and who is down, over whatever the search is
// currently showing - so the same date box that finds October's games also answers how October
// went. The portal admin keeps the books, so this is his; a member's own standing is on his Me
// screen, where it is about him rather than about everybody.
function bookRows(games) {
  var by = {};
  games.forEach(function (g) {
    (g.people || []).forEach(function (pl) {
      var k = pl.memberId || pl.name;
      var r = by[k] = by[k] || { id: k, name: pl.name, games: 0, inn: 0, out: 0, net: 0, best: 0, worst: 0, owed: 0, owes: 0 };
      r.games += 1; r.inn += pl.invested || 0; r.out += pl.final || 0; r.net += pl.net || 0;
      if ((pl.net || 0) > r.best) r.best = pl.net;
      if ((pl.net || 0) < r.worst) r.worst = pl.net;
    });
    (g.transfers || []).forEach(function (x) {
      if (x.confirmedAt) return;                       // settled; it is history, not an open book
      if (by[x.from]) by[x.from].owes += x.amount;
      if (by[x.to]) by[x.to].owed += x.amount;
    });
  });
  return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.net - a.net; });
}

function theBooks() {
  if (!(S.me && S.me.isAdmin)) return '';
  var games = historyShown();
  if (!games.length) return '';
  var rows = bookRows(games);
  var hands = games.reduce(function (a, g) { return a + (g.hands || 0); }, 0);
  var inn = rows.reduce(function (a, r) { return a + r.inn; }, 0);
  var open = rows.reduce(function (a, r) { return a + r.owes; }, 0);
  var h = '<div class="h2">THE BOOKS</div>'
    + '<div class="evc"><div class="muted small" style="white-space:normal;margin-bottom:8px">'
    + games.length + ' game' + (games.length === 1 ? '' : 's') + ' &middot; ' + fmt(hands) + ' hands dealt &middot; '
    + fmt(inn) + ' chips bought in'
    + (open ? ' &middot; <span style="color:#f0c674">' + fmt(open) + ' still to settle</span>' : ' &middot; all settled')
    + '</div>';
  rows.forEach(function (r) {
    h += '<div class="row" style="min-height:44px"><div style="flex:1;min-width:0">'
      + '<div style="font-size:14px;font-weight:600">' + esc(r.name)
      + (r.owes ? ' <span class="pill2" style="background:#3a2f12;color:#f0c674">owes ' + fmt(r.owes) + '</span>' : '')
      + '</div>'
      + '<div class="muted small">' + r.games + ' game' + (r.games === 1 ? '' : 's')
      + ' &middot; in ' + fmt(r.inn) + ' &middot; out ' + fmt(r.out)
      + (r.games > 1 ? ' &middot; best ' + (r.best > 0 ? '+' : '') + fmt(r.best) + ', worst ' + fmt(r.worst) : '')
      + '</div></div>'
      + '<div style="text-align:right"><div style="font-weight:700;color:'
      + (r.net > 0 ? '#7ddba0' : r.net < 0 ? '#f08a8f' : '#a3aba5') + '">'
      + (r.net > 0 ? '+' : '') + fmt(r.net) + '</div>'
      + (r.owed ? '<div class="muted small">due ' + fmt(r.owed) + '</div>' : '')
      + '</div></div>';
  });
  // The one figure that proves the rest: chips are neither made nor destroyed, so every game's
  // wins and losses have to cancel. If this is not zero something upstream is wrong, and seeing
  // it beats trusting it.
  var sum = rows.reduce(function (a, r) { return a + r.net; }, 0);
  h += '<div class="muted small" style="margin-top:8px;border-top:1px solid #2a312d;padding-top:8px">'
    + (sum === 0 ? 'Wins and losses cancel exactly, as they must.'
                 : '<span style="color:#f08a8f">These games are out by ' + fmt(sum) + ' - tell Claude.</span>')
    + '</div></div>';
  return h;
}

// ---- drawing ----
// Hand-rolled SVG rather than a charting library: two shapes are all this needs, and a library
// would be larger than the rest of the app put together for the privilege.
function lineChart(series, opts) {
  opts = opts || {};
  var W = 350, H = opts.height || 140, L = 34, B = 18, T = 8;
  var pts = [];
  series.forEach(function (s) { s.points.forEach(function (p) { pts.push(p); }); });
  if (pts.length < 2) return '<div class="muted small">Not enough played to draw a line yet.</div>';
  var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
  var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
  var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  if (opts.zero) { y0 = Math.min(0, y0); y1 = Math.max(0, y1); }
  if (y1 === y0) { y1 = y0 + 1; }
  var pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
  var X = function (v) { return L + (x1 === x0 ? 0 : (v - x0) / (x1 - x0)) * (W - L - 6); };
  var Y = function (v) { return T + (1 - (v - y0) / (y1 - y0)) * (H - T - B); };

  var g = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" style="display:block">';
  // a line at nothing, so up and down are obvious at a glance
  if (y0 < 0 && y1 > 0) {
    g += '<line x1="' + L + '" y1="' + Y(0).toFixed(1) + '" x2="' + (W - 6) + '" y2="' + Y(0).toFixed(1) + '" stroke="#3a443e" stroke-dasharray="3 3"/>';
  }
  g += '<text x="2" y="' + (Y(y1) + 9).toFixed(1) + '" fill="#a3aba5" font-size="9">' + kfmt(Math.round(y1)) + '</text>';
  g += '<text x="2" y="' + Y(y0).toFixed(1) + '" fill="#a3aba5" font-size="9">' + kfmt(Math.round(y0)) + '</text>';
  series.forEach(function (sr) {
    var d = sr.points.map(function (pt, i) { return (i ? 'L' : 'M') + X(pt[0]).toFixed(1) + ' ' + Y(pt[1]).toFixed(1); }).join(' ');
    g += '<path d="' + d + '" fill="none" stroke="' + sr.colour + '" stroke-width="' + (sr.thick ? 2.4 : 1.2) + '"'
      + (sr.thick ? '' : ' opacity=".5"') + ' stroke-linejoin="round" stroke-linecap="round"/>';
    if (sr.thick) {
      var last = sr.points[sr.points.length - 1];
      g += '<circle cx="' + X(last[0]).toFixed(1) + '" cy="' + Y(last[1]).toFixed(1) + '" r="3" fill="' + sr.colour + '"/>';
    }
  });
  g += '</svg>';
  if (opts.xlabel) g += '<div class="muted small" style="text-align:center;margin-top:2px">' + opts.xlabel + '</div>';
  return g;
}

// how a night went for everybody, with your own line picked out
function gameCurve(g) {
  var curve = g.curve || {};
  var meRow = (g.people || []).filter(function (p) { return p.memberId === (S.me && S.me.id); })[0];
  var series = [];
  (g.people || []).forEach(function (p) {
    var line = curve[p.id];
    if (!line || line.length < 2) return;
    series.push({ points: line, colour: meRow && p.id === meRow.id ? '#d8b45c' : '#6f8a7b', thick: !!(meRow && p.id === meRow.id) });
  });
  if (!series.length) return '';
  return '<div class="h2" style="margin:12px 0 4px">CHIPS THROUGH THE NIGHT</div>'
    + lineChart(series, { xlabel: 'hand 1 to ' + g.hands + (meRow ? ' &middot; your line in gold' : '') });
}

// what the portal has done to you over the months
function overallCurve() {
  var meId = S.me && S.me.id;
  var games = (S.history || []).slice().filter(function (g) {
    return (g.people || []).some(function (p) { return p.memberId === meId; });
  }).sort(function (a, b) { return a.at - b.at; });
  if (games.length < 2) return '';
  var run = 0, pts = [];
  games.forEach(function (g, i) {
    var mine = g.people.filter(function (p) { return p.memberId === meId; })[0];
    run += mine ? mine.net : 0;
    pts.push([i + 1, run]);
  });
  return '<div class="h2">WHERE YOU STAND</div>'
    + '<div class="evc">' + lineChart([{ points: pts, colour: run >= 0 ? '#7ddba0' : '#f08a8f', thick: true }], { zero: true, xlabel: games.length + ' games &middot; running total' })
    + '<div style="display:flex;justify-content:space-between;margin-top:8px">'
    + '<div class="muted small">' + games.length + ' games played</div>'
    + '<div style="font-weight:700;color:' + (run > 0 ? '#7ddba0' : run < 0 ? '#f08a8f' : '#a3aba5') + '">'
    + (run > 0 ? '+' : '') + fmt(run) + '</div></div></div>';
}

function historyList() {
  var shown = historyShown();
  if (!shown.length) return '<div class="evc"><div class="muted small">Nothing matches that. Try a different word, or clear the dates.</div></div>';
  var h = '';
  shown.forEach(function (g) {
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
          + '<div class="muted small">in ' + fmt(p.invested) + ' &middot; out ' + fmt(p.final)
          + (p.rawFinal !== undefined && p.rawFinal !== p.final ? ' <span class="muted">(' + fmt(p.rawFinal) + ' rounded)</span>' : '')
          + '</div></div>'
          + '<div style="font-weight:700;color:' + (p.net > 0 ? '#7ddba0' : p.net < 0 ? '#f08a8f' : '#a3aba5') + '">' + (p.net > 0 ? '+' : '') + fmt(p.net) + '</div>'
          + (S.me && S.me.isAdmin
            ? '<a class="rolechip" style="text-decoration:none;display:flex;align-items:center" target="_blank" rel="noopener" href="/api/statement?token='
              + encodeURIComponent(S.token) + '&id=' + g.id + '&who=' + encodeURIComponent(p.id) + '">PDF</a>'
            : '')
          + '</div>';
      });
      h += '</div>';
      // your own account for the night, before the rest of the table's
      var mine = g.people.filter(function (p) { return p.memberId === (S.me && S.me.id); })[0];
      if (mine) {
        h += '<div class="h2" style="margin:12px 0 4px">YOUR ACCOUNT</div>'
          + '<div class="evc" style="margin:0">'
          + acctRow('Bought in for', fmt(mine.invested))
          + acctRow('Finished with', fmt(mine.final) + (mine.rawFinal !== undefined && mine.rawFinal !== mine.final ? ' <span class="muted small">(' + fmt(mine.rawFinal) + ' rounded)</span>' : ''))
          + acctRow(mine.net >= 0 ? 'You are up' : 'You are down',
              '<span style="color:' + (mine.net > 0 ? '#7ddba0' : mine.net < 0 ? '#f08a8f' : '#a3aba5') + '">' + (mine.net > 0 ? '+' : '') + fmt(mine.net) + '</span>')
          + '</div>';
      }
      h += gameCurve(g);

      h += '<div class="h2" style="margin:12px 0 4px">WHO PAYS WHO</div>';
      if (g.transfers && g.transfers.length) {
        g.transfers.forEach(function (x) { h += payRow(g, x); });
      } else {
        // it does happen: a night called off before a hand finished, or everyone exactly even
        h += '<div class="muted small" style="white-space:normal">Nobody owes anybody. Everyone finished on what they put in.</div>';
      }
      h += '<a class="btn ghost" style="margin-top:12px;display:flex;align-items:center;justify-content:center;text-decoration:none" target="_blank" rel="noopener" href="/api/statement?token=' + encodeURIComponent(S.token) + '&id=' + g.id + '">Statement (PDF)</a>';
      if (g.replays) h += '<button class="btn ghost" style="margin-top:8px" onclick="loadReplay(\'' + g.id + '\')">Best ' + g.replays + ' hands</button>';
      // Trial games and games that went wrong should not sit in the records for ever. Only the
      // portal admin can throw one away, and it goes for everybody who played in it.
      if (S.me && S.me.isAdmin) {
        h += '<button class="btn ghost" style="margin-top:8px;border-color:#6b2a2e;color:#d2454d" onclick="removeGame(\'' + g.id + '\')">Remove from the records</button>';
      }
    }
    h += '</div>';
  });
  return h;
}
function acctRow(k, v) {
  return '<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid #1d2420">'
    + '<div class="muted small">' + k + '</div><div style="font-size:14px;font-weight:700">' + v + '</div></div>';
}

// One debt, and what can be done about it. The person paying can say he has paid; only the person
// owed can say it arrived. The portal admin can enter that for somebody unreachable, and it says
// so on the record afterwards rather than looking like he quietly settled it himself.
function payRow(g, x) {
  var meId = S.me && S.me.id;
  var isPayer = x.from === meId, isPayee = x.to === meId, boss = S.me && S.me.isAdmin;
  var done = !!x.confirmedAt;
  var h = '<div class="evc" style="margin:6px 0 0;padding:10px">'
    + '<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">'
    + '<div style="font-size:13px">' + esc(x.fromName) + ' pays ' + esc(x.toName) + '</div>'
    + '<div class="gold" style="font-weight:700">' + fmt(x.amount) + '</div></div>';
  if (done) {
    h += '<div class="muted small" style="margin-top:4px">Settled ' + when(x.confirmedAt)
      + (x.onBehalf ? ' &middot; entered by ' + esc(x.confirmedByName || 'the portal admin') + ' on ' + esc(x.toName) + '\u2019s behalf' : '')
      + '</div>';
    return h + '</div>';
  }
  var hrs = Math.floor((Date.now() - g.at) / 3600e3);
  h += '<div class="muted small" style="margin-top:4px">'
    + (x.paidAt ? esc(x.fromName) + ' says this was paid ' + when(x.paidAt) + ' &mdash; waiting on ' + esc(x.toName) + ' to confirm'
                : 'Not settled' + (hrs >= 1 ? ' &middot; ' + hrs + ' hours since the statement' : ''))
    + '</div>';
  if (isPayee || (boss && !isPayer)) {
    h += '<button class="btn" style="margin-top:8px;height:40px;font-size:14px" onclick="confirmPay(\'' + g.id + '\',\'' + x.from + '\',\'' + x.to + '\')">'
      + (isPayee ? 'I have been paid' : 'Enter receipt for ' + esc(x.toName)) + '</button>';
  }
  if (isPayer && !x.paidAt) {
    h += '<button class="btn ghost" style="margin-top:8px;height:40px;font-size:14px" onclick="markPaid(\'' + g.id + '\',\'' + x.from + '\',\'' + x.to + '\')">I have paid this</button>';
  }
  if (isPayer && x.paidAt) {
    h += '<div class="muted small" style="margin-top:6px;white-space:normal">You have marked it paid. It only clears when '
      + esc(x.toName) + ' confirms &mdash; give him a nudge if it is holding you up.</div>';
  }
  return h + '</div>';
}
function markPaid(id, from, to) {
  api('pay-mark', { id: id, from: from, to: to })
    .then(function () { toast('Marked as paid'); return refresh(); }).catch(fail);
}
function confirmPay(id, from, to) {
  api('pay-confirm', { id: id, from: from, to: to })
    .then(function (j) { toast(j.onBehalf ? 'Entered on their behalf' : 'Settled'); return refresh(); }).catch(fail);
}

function loadReplay(id) { api('replay', { id: id }).then(function (j) { S.replay = { id: id, rounds: j.rounds, i: 0 }; render(); }).catch(fail); }

// ---------------------------------------------------------------- me / portal
// What is outstanding, put where it cannot be missed. A debt nobody is reminded of is a debt that
// turns into a flag, and a flag at this table stops somebody playing - so being told plainly is
// the kindest part of the whole arrangement.
function owedBox() {
  var f = (S.flags || {}), pay = S.toPay || [], get = S.toGet || [];
  var h = '';
  if (f.red) {
    h += '<div class="evc" style="margin-top:16px;border-color:#d2454d">'
      + '<div style="font-weight:700;color:#f08a8f">You have a red flag</div>'
      + '<div class="muted small" style="white-space:normal;margin-top:3px">' + esc(f.redWhy || '') + '. '
      + 'You cannot sit at a table until the portal admin lifts it. Settle up first, then ask him.</div></div>';
  } else if (f.yellow) {
    h += '<div class="evc" style="margin-top:16px;border-color:#d8b45c">'
      + '<div class="gold" style="font-weight:700">' + f.yellow + ' unsettled ' + (f.yellow === 1 ? 'debt' : 'debts') + '</div>'
      + '<div class="muted small" style="white-space:normal;margin-top:3px">You can still play, but whoever runs the table has to let you in. '
      + 'It clears the moment each one is confirmed received.</div></div>';
  }
  if (pay.length) {
    h += '<div class="h2">YOU OWE</div>';
    pay.forEach(function (d) {
      h += '<div class="evc" style="margin:6px 0 0;padding:10px"><div style="display:flex;justify-content:space-between;gap:8px">'
        + '<div style="font-size:14px">' + esc(d.toName) + '</div>'
        + '<div class="gold" style="font-weight:700">' + fmt(d.amount) + '</div></div>'
        + '<div class="muted small" style="margin-top:3px">' + esc(d.title || 'a game') + ' &middot; ' + when(d.when)
        + (d.paidAt ? ' &middot; you marked it paid' : '') + '</div>'
        + (d.paidAt ? '<div class="muted small" style="margin-top:6px;white-space:normal">Waiting on ' + esc(d.toName)
            + ' to confirm. If it is holding you up, give him a nudge &mdash; only he can clear it.</div>'
          : '<button class="btn ghost" style="margin-top:8px;height:38px;font-size:13px" onclick="markPaid(\'' + d.gameId + '\',\'' + d.from + '\',\'' + d.to + '\')">I have paid this</button>')
        + '</div>';
    });
  }
  if (get.length) {
    h += '<div class="h2">COMING TO YOU</div>';
    get.forEach(function (d) {
      h += '<div class="evc" style="margin:6px 0 0;padding:10px"><div style="display:flex;justify-content:space-between;gap:8px">'
        + '<div style="font-size:14px">' + esc(d.fromName) + '</div>'
        + '<div class="gold" style="font-weight:700">' + fmt(d.amount) + '</div></div>'
        + '<div class="muted small" style="margin-top:3px">' + esc(d.title || 'a game') + ' &middot; ' + when(d.when)
        + (d.paidAt ? ' &middot; he says he has paid' : '') + '</div>'
        + '<button class="btn" style="margin-top:8px;height:38px;font-size:13px" onclick="confirmPay(\'' + d.gameId + '\',\'' + d.from + '\',\'' + d.to + '\')">I have been paid</button>'
        + '</div>';
    });
  }
  // and the portal admin sees who is barred, and can lift it
  if (S.me && S.me.isAdmin && (S.flagged || []).length) {
    h += '<div class="h2">RED FLAGS</div>';
    S.flagged.forEach(function (x) {
      h += '<div class="evc" style="margin:6px 0 0;padding:10px;border-color:#6b2a2e">'
        + '<div style="font-size:14px;font-weight:600">' + esc(x.name) + '</div>'
        + '<div class="muted small" style="margin-top:3px">' + esc(x.why) + ' &middot; since ' + when(x.at) + '</div>'
        + '<button class="btn ghost" style="margin-top:8px;height:38px;font-size:13px" onclick="clearFlag(\'' + x.id + '\')">Lift the red flag</button></div>';
    });
  }
  return h;
}
function clearFlag(id) {
  api('flag-clear', { memberId: id }).then(function () { toast('Lifted'); return refresh(); }).catch(fail);
}

// ---- the books, across every game ----
// The portal admin is the only person who sees all of this. A member's own history answers how
// his nights have gone; this answers how the group is going, which is a different question and
// the one somebody settling arguments actually needs.
function allStats() {
  var per = {}, hands = 0, moved = 0, first = 0;
  (S.history || []).forEach(function (g) {
    hands += g.hands || 0;
    var at = g.startedAt || g.at;
    if (at && (!first || at < first)) first = at;
    (g.transfers || []).forEach(function (x) { moved += x.amount; });
    (g.people || []).forEach(function (pl) {
      var k = pl.memberId || pl.name;
      var r = per[k] = per[k] || { id: pl.memberId, name: pl.name, games: 0, invested: 0, final: 0, net: 0, best: null, worst: null };
      r.games += 1; r.invested += pl.invested || 0; r.final += pl.final || 0; r.net += pl.net || 0;
      if (r.best === null || pl.net > r.best) r.best = pl.net;
      if (r.worst === null || pl.net < r.worst) r.worst = pl.net;
    });
  });
  var rows = [];
  for (var k in per) if (per.hasOwnProperty(k)) rows.push(per[k]);
  rows.sort(function (a, b) { return b.net - a.net; });
  return { rows: rows, hands: hands, moved: moved, first: first, games: (S.history || []).length };
}

// Every debt in the portal that nobody has confirmed, oldest first - which is the order they
// turn yellow and then red in, so it is the order worth chasing them in.
function debtsOutstanding() {
  var out = [];
  (S.history || []).forEach(function (g) {
    (g.transfers || []).forEach(function (x) {
      if (!x.confirmedAt) out.push({ g: g, x: x });
    });
  });
  return out.sort(function (a, b) { return (a.g.at || 0) - (b.g.at || 0); });
}

function flagPill(m) {
  if (!m || !m.flags) return '';
  if (m.flags.red) return '<span class="pill2" style="background:#3a1418;color:#f08a8f;border-color:#6b2a2e">RED</span>';
  if (m.flags.yellow) return '<span class="pill2" style="background:#332a12;color:#d8b45c;border-color:#5c4a1e">YELLOW</span>';
  return '';
}

function statsBlock() {
  var st = allStats();
  var h = '<div class="h2">THE PORTAL SO FAR</div>';
  if (!st.games) {
    return h + '<div class="evc"><div class="muted small" style="white-space:normal">No games on record yet. '
      + 'Everything here fills in as soon as a game ends.</div></div>';
  }
  h += '<div class="evc">'
    + acctRow('Games on record', fmt(st.games))
    + acctRow('Hands dealt', fmt(st.hands))
    + acctRow('Chips changing hands', fmt(st.moved))
    + (st.first ? acctRow('First game', when(st.first)) : '')
    + '</div>';

  h += '<div class="h2">WHERE EVERYBODY STANDS</div>'
    + '<div class="muted small" style="margin:-2px 2px 8px;white-space:normal">Every game in the portal, '
    + 'added up. Tap a night under History for the detail.</div>';
  var byId = {};
  (S.members || []).forEach(function (m) { byId[m.id] = m; });
  st.rows.forEach(function (r) {
    var m = byId[r.id];
    h += '<div class="row" style="margin-top:6px;min-height:46px"><div style="flex:1;min-width:0">'
      + '<div style="font-size:14px;font-weight:600">' + esc(r.name) + ' ' + flagPill(m) + '</div>'
      + '<div class="muted small">' + r.games + (r.games === 1 ? ' game' : ' games')
      + ' &middot; in ' + fmt(r.invested) + ' &middot; out ' + fmt(r.final)
      + (r.best !== null ? ' &middot; best ' + (r.best > 0 ? '+' : '') + fmt(r.best) : '')
      + (r.worst !== null ? ' &middot; worst ' + fmt(r.worst) : '')
      + '</div></div>'
      + '<div style="font-weight:700;color:' + (r.net > 0 ? '#7ddba0' : r.net < 0 ? '#f08a8f' : '#a3aba5') + '">'
      + (r.net > 0 ? '+' : '') + fmt(r.net) + '</div></div>';
  });

  var owed = debtsOutstanding();
  h += '<div class="h2">MONEY STILL OUT</div>';
  if (!owed.length) {
    h += '<div class="evc"><div class="muted small">Everything is settled. Nobody owes anybody.</div></div>';
  } else {
    h += '<div class="muted small" style="margin:-2px 2px 8px;white-space:normal">Oldest first, which is the '
      + 'order they go yellow and then red in. You can enter a receipt for somebody unreachable from the '
      + 'game itself, under History.</div>';
    owed.forEach(function (d) {
      var hrs = Math.floor((Date.now() - d.g.at) / 3600e3);
      h += '<div class="row" style="margin-top:6px;min-height:44px"><div style="flex:1;min-width:0">'
        + '<div style="font-size:14px">' + esc(d.x.fromName) + ' &rarr; ' + esc(d.x.toName) + '</div>'
        + '<div class="muted small">' + esc(d.g.formatName) + ' &middot; ' + when(d.g.at)
        + ' &middot; ' + hrs + (hrs === 1 ? ' hour' : ' hours') + ' ago'
        + (d.x.paidAt ? ' &middot; ' + esc(d.x.fromName) + ' says it is paid' : '') + '</div></div>'
        + '<div class="gold" style="font-weight:700">' + fmt(d.x.amount) + '</div></div>';
    });
  }

  // Lifting a red flag is the one thing only he can do, so it belongs where he can see who has one
  // rather than buried in a game from four days ago.
  var red = (S.members || []).filter(function (m) { return m.flags && m.flags.red; });
  if (red.length) {
    h += '<div class="h2">RED FLAGS</div>'
      + '<div class="muted small" style="margin:-2px 2px 8px;white-space:normal">A red flag stays until you '
      + 'lift it, even once the money has arrived. Nobody red-flagged can sit at a table or watch one.</div>';
    red.forEach(function (m) {
      h += '<div class="row" style="margin-top:6px;min-height:44px"><div style="flex:1;min-width:0">'
        + '<div style="font-size:14px;font-weight:600">' + esc(m.name) + '</div>'
        + '<div class="muted small" style="white-space:normal">' + esc(m.flags.redWhy || '')
        + (m.flags.redAt ? ' &middot; since ' + when(m.flags.redAt) : '') + '</div></div>'
        + '<button class="rolechip on" onclick="clearFlag(\'' + m.id + '\')">Lift it</button></div>';
    });
  }
  return h;
}

function meTab() {
  var h = owedBox() + overallCurve();
  h += '<div class="evc" style="margin-top:16px"><div class="muted small">SIGNED IN AS</div>'
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

  h += statsBlock();

  h += '<div class="h2">MEMBERS (' + S.members.length + ')</div>'
    + '<div class="muted small" style="margin:-2px 2px 8px;white-space:normal">Add somebody with their name and mobile number. They sign in with that number and set their own passcode the first time. '
    + 'Everybody plays; only a <span class="gold">primary</span> member can start a table. New members come in as secondary \u2014 tap the chip beside a name to change it.</div>'
    + '<div class="evc"><div style="display:flex;gap:8px">'
    + '<input id="am_name" placeholder="Name" maxlength="18" style="flex:1;min-width:0;height:46px;border-radius:10px;border:1px solid #2a312d;background:#141917;color:#f2efe6;font-size:15px;padding:0 12px;font-family:inherit">'
    + '<input id="am_phone" placeholder="Mobile" inputmode="tel" style="flex:1;min-width:0;height:46px;border-radius:10px;border:1px solid #2a312d;background:#141917;color:#f2efe6;font-size:15px;padding:0 12px;font-family:inherit"></div>'
    + '<button class="btn" style="margin-top:8px;height:46px" onclick="addMember()">Add member</button></div>';
  h += '<button class="btn ghost" style="margin-top:8px" onclick="portalInvite()">Share the portal with the group</button>';
  S.members.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (m) {
    h += '<div class="row" style="margin-top:8px"><div style="flex:1;min-width:0">'
      + '<div style="font-size:14px;font-weight:600">' + esc(m.name) + (m.isAdmin ? ' <span class="gold" style="font-size:10px">ADMIN</span>' : '') + '</div>'
      + '<div class="muted small">' + esc(m.phone) + ' &middot; ' + (m.hasPin ? 'signed in before' : 'has not signed in yet')
      + ' &middot; ' + (m.canOpen ? '<span class="gold">can start a game</span>' : 'plays only') + '</div></div>'
      + (m.isAdmin ? '' : '<button class="rolechip' + (m.tier === 'primary' ? ' on' : '') + '" onclick="setTier(\'' + m.id + '\',\'' + (m.tier === 'primary' ? 'secondary' : 'primary') + '\')">'
        + (m.tier === 'primary' ? 'Primary' : 'Secondary') + '</button>'
        + '<button class="rolechip on" onclick="memberLink(\'' + m.id + '\')">Send link</button>'
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
// The message that opens the portal to the group. The portal writes it, names and all, so the
// people who can start a game are whoever is set to primary right now.
function portalInvite() {
  api('portal-invite', {}).then(function (j) {
    S.invite = { code: '', text: j.text, group: true };
    render();
  }).catch(fail);
}
function setTier(id, tier) { api('member-tier', { memberId: id, tier: tier }).then(refresh).catch(fail); }
function removeMember(id, name) { if (!confirm('Remove ' + name + '?')) return; api('member-remove', { memberId: id }).then(refresh).catch(fail); }
function resetMember(id, name) { if (!confirm('Forget ' + name + "'s passcode? They set a new one next time they sign in.")) return; api('member-reset', { memberId: id }).then(function () { toast('Done'); refresh(); }).catch(fail); }
