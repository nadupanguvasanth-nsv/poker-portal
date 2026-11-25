// ---------------------------------------------------------------- the table
// The presentation here is the one settled on in the first build, carried across whole rather
// than rewritten: the felt in the top half, your own cards and the buttons below it, bullseyes
// to aim at, and cards drawn as cards. What feeds it is the rebuilt portal, through adapt().
var CX = 195, CY = 224, RX = 152, RY = 114, MINE = 404;

// ---- holding your cards up to look at them ----
function applyUp() { var h = document.getElementById('hero'); if (h) h.classList.toggle('up', !!(S.peek || S.lock)); }
document.addEventListener('pointerdown', function (e) {
  if (e.target.closest && e.target.closest('#hero')) { S.peek = true; S.pt = Date.now(); applyUp(); }
});
function endPeek() { if (!S.peek) return; S.peek = false; if (Date.now() - S.pt < 250) S.lock = !S.lock; applyUp(); }
document.addEventListener('pointerup', endPeek);
document.addEventListener('pointercancel', endPeek);
document.addEventListener('contextmenu', function (e) { if (e.target.closest && e.target.closest('#hero')) e.preventDefault(); });

// ---- a card is drawn, not typed ----
function card(c, cls) {
  cls = cls || '';
  if (!c || c === '??') return '<div class="card back ' + cls + '"></div>';
  var r = c[0] === 'T' ? '10' : c[0], su = c[c.length - 1], red = (su === 'h' || su === 'd');
  if (S.win && S.win[c]) cls += ' win';
  return '<div class="card ' + (red ? 'red ' : '') + cls + '">' + cardFace(r, su, /(^| )sm( |$)/.test(cls)) + '</div>';
}
function cardHtml(c, size, extra) { return card(c, (size || '') + (extra ? ' ' + extra : '')); }

var SUIT_SHAPE = {
  h: '<path d="M5 9.15 L1.68 5.83 A2.35 2.35 0 1 1 5 2.5 A2.35 2.35 0 1 1 8.32 5.83 Z"/>',
  s: '<g transform="rotate(180 5 5)"><path d="M5 9.15 L1.68 5.83 A2.35 2.35 0 1 1 5 2.5 A2.35 2.35 0 1 1 8.32 5.83 Z"/></g><path d="M3.9 9.6 Q5 6.9 6.1 9.6 Z"/>',
  d: '<path d="M5 0.6 L8.95 5 L5 9.4 L1.05 5 Z"/>',
  c: '<circle cx="5" cy="3.15" r="2.1"/><circle cx="2.75" cy="6.4" r="2.1"/><circle cx="7.25" cy="6.4" r="2.1"/><path d="M3.9 9.7 Q5 7 6.1 9.7 Z"/>'
};
function suitAt(su, x, y, sz) { return '<g transform="translate(' + (x - sz / 2) + ' ' + (y - sz / 2) + ') scale(' + (sz / 10) + ')">' + SUIT_SHAPE[su] + '</g>'; }
var PIP_ROWS = {
  '2': [[1, 0], [1, 4]], '3': [[1, 0], [1, 2], [1, 4]], '4': [[0, 0], [2, 0], [0, 4], [2, 4]],
  '5': [[0, 0], [2, 0], [1, 2], [0, 4], [2, 4]], '6': [[0, 0], [2, 0], [0, 2], [2, 2], [0, 4], [2, 4]],
  '7': [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2], [0, 4], [2, 4]],
  '8': [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2], [1, 3], [0, 4], [2, 4]],
  '9': [[0, 0], [2, 0], [0, 1.34], [2, 1.34], [1, 2], [0, 2.66], [2, 2.66], [0, 4], [2, 4]],
  '10': [[0, 0], [2, 0], [1, 0.67], [0, 1.34], [2, 1.34], [0, 2.66], [2, 2.66], [1, 3.33], [0, 4], [2, 4]]
};

// A jack, queen or king: a figure in the panel rather than a bare letter, mirrored top and
// bottom the way a real court card is, so it reads the same whichever way up you hold it.
function courtHalf(r, su) {
  // a crowned bust: crown or cap, a face, a collar and a robe carrying the suit. Small, but it
  // reads as a figure rather than a letter, the way a real court card does.
  var crown = r === 'K'
    ? '<path d="M24.8 23.4 L26.3 18.2 L28.7 21.4 L31 16.6 L33.3 21.4 L35.7 18.2 L37.2 23.4 Z"/>'
      + '<rect x="24.6" y="23.3" width="12.8" height="1.9" rx="0.6"/>'
    : r === 'Q'
    ? '<path d="M25.2 23.4 L26.6 19 L28.9 21.1 L31 17.4 L33.1 21.1 L35.4 19 L36.8 23.4 Z"/>'
      + '<circle cx="31" cy="15.9" r="1.3"/><rect x="25" y="23.3" width="12" height="1.7" rx="0.6"/>'
    : '<path d="M24.6 23.6 Q26.6 18.4 31 18 Q35.4 18.4 37.4 23.6 Z"/>'
      + '<path d="M36.8 19.6 Q40.4 16.6 41.2 20.8 Q38.6 21.3 37.6 23 Z"/>';
  return crown
    // the face
    + '<path d="M27.4 25.6 h7.2 v3.9 a3.6 3.6 0 0 1 -7.2 0 z" fill="currentColor" fill-opacity=".1"'
    + ' stroke="currentColor" stroke-width="0.9"/>'
    + '<circle cx="29.5" cy="27.6" r="0.62"/><circle cx="32.5" cy="27.6" r="0.62"/>'
    + '<path d="M29.7 30.4 Q31 31.3 32.3 30.4" fill="none" stroke="currentColor" stroke-width="0.6"/>'
    // the collar
    + '<path d="M25.6 34.4 L28 32.2 L31 34.2 L34 32.2 L36.4 34.4 L34.4 35.8 L31 34.9 L27.6 35.8 Z"/>'
    // the robe, with the suit on it
    + '<path d="M26.6 36.6 Q31 35.4 35.4 36.6 L37 42.4 L25 42.4 Z" fill="currentColor" fill-opacity=".14"'
    + ' stroke="currentColor" stroke-width="0.8"/>'
    + suitAt(su, 31, 39.6, 5.2);
}

function cardFace(r, su, small) {
  var W = 62, H = 86, g = '';
  if (small) {           // a seat-sized card: one rank, one suit, nothing to squint at
    return '<svg class="cf" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true">'
      + '<text x="31" y="40" text-anchor="middle" font-size="' + (r === '10' ? 30 : 34) + '" font-weight="700" font-family="Georgia,\'Times New Roman\',serif">' + r + '</text>'
      + suitAt(su, 31, 60, 24) + '</svg>';
  }
  var ix = function () {
    var fs = r === '10' ? 11 : 13.5;
    return '<text x="8.6" y="15.4" text-anchor="middle" font-size="' + fs + '" font-weight="700" font-family="Georgia,\'Times New Roman\',serif">' + r + '</text>' + suitAt(su, 8.6, 21.6, 7.4);
  };
  g += ix() + '<g transform="rotate(180 31 43)">' + ix() + '</g>';
  if (PIP_ROWS[r]) {
    g += PIP_ROWS[r].map(function (p) {
      var x = [21.5, 31, 40.5][p[0]], y = 18.5 + p[1] * 12.4;
      return suitAt(su, x, y, 11.4);
    }).join('');
  } else if (r === 'A') {
    g += suitAt(su, 31, 43, 30);
  } else {
    g += '<rect x="17.5" y="14.5" width="27" height="57" rx="2.5" fill="currentColor" fill-opacity=".05" stroke="currentColor" stroke-opacity=".5" stroke-width="0.9"/>'
      + '<line x1="17.5" y1="43" x2="44.5" y2="43" stroke="currentColor" stroke-opacity=".28" stroke-width="0.7"/>';
    var half = courtHalf(r, su);
    g += half + '<g transform="rotate(180 31 43)">' + half + '</g>';
  }
  return '<svg class="cf" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' + g + '</svg>';
}
function initials(n) { return esc(String(n || '').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 2).toUpperCase() || '?'); }

// ---- where everybody sits ----
function seatXY(rel, n) { var a = Math.PI / 2 + rel / n * 2 * Math.PI; return { x: CX + RX * Math.cos(a), y: CY + RY * Math.sin(a) }; }
function bullSvg() {
  return '<svg viewBox="0 0 52 52" style="position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none">'
    + '<circle cx="26" cy="26" r="24" fill="none" stroke="#d2454d" stroke-opacity=".55" stroke-width="3"/>'
    + '<circle cx="26" cy="26" r="16" fill="none" stroke="#e8ece9" stroke-opacity=".4" stroke-width="3"/>'
    + '<circle cx="26" cy="26" r="8" fill="none" stroke="#d2454d" stroke-opacity=".55" stroke-width="3"/></svg>';
}
function behindTag(st) {
  if (!st || !st.bought) return '';
  var d = st.bought - st.stack;
  if (!d) return '';
  return '<div class="sbh" style="color:' + (d > 0 ? '#f08a8f' : '#7ddba0') + '">' + (d > 0 ? '-' : '+') + kfmt(Math.abs(d)) + '</div>';
}

// ---- bombs and flowers ----
function fxPos(A, id) {
  var n = A.seats.length, ms = A.you.seat;
  for (var s = 0; s < n; s++) {
    var st = A.seats[s];
    if (st && st.id === id) {
      var rel = (s - ms + n) % n;
      if (rel === 0) return { x: 245, y: 462 };
      var p = seatXY(rel, n);
      return { x: p.x, y: p.y };
    }
  }
  return null;
}
function fxCanPlay(A) { return !!(A.you && A.you.seat >= 0 && !A.you.watching); }
function fxOpen(id) { S.fxMenu = (S.fxMenu === id) ? null : id; render(); }
function fxSend(kind, to) {
  S.fxMenu = null; render();
  api('react', { code: S.code, kind: kind, to: to || '' }).catch(function (e) {
    if (e && e.message && /one at a time/i.test(e.message)) return;
    fail(e);
  });
}
// Taken in once, by id, and then left to play out. Re-deriving them from the server on every
// redraw restarted the animation each time, so nothing ever got across the table.
function fxIngest(v) {
  var fx = v.fx || [];
  if (S.fxMax === undefined) { S.fxMax = fx.length ? fx[fx.length - 1].id : 0; return; }
  S.fxLive = S.fxLive || [];
  fx.forEach(function (f) {
    if (f.id <= S.fxMax) return;
    S.fxMax = f.id;
    var age = (v.now || Date.now()) - f.at;
    if (age > 4000) return;
    // a hand worth a noise: fireworks over the table rather than a bubble over one seat
    if (f.kind === 'sky') {
      if (S.screen === 'table') celebrateSky(f.level || 1, f.title || '', f.who || '');
      return;
    }
    S.fxLive.push({ id: f.id, k: f.k, icon: f.icon, hit: f.hit, from: f.from, to: f.to, t0: Date.now() - Math.max(0, age) });
    if (f.to && S.v && S.v.me && f.to === S.v.me.id && navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} }
  });
  if (S.fxLive.length) { clearTimeout(S.fxTimer); S.fxTimer = setTimeout(function () { if (S.screen === 'table') render(); }, 3400); }
}
// The pot sits in the middle of the felt; chips fly from whoever paid them to there.
var POT_AT = { x: 195, y: 176 };
function chipHtml(A) {
  var live = S.chips || [];
  if (!live.length) return '';
  var now = Date.now(), h = '';
  live.forEach(function (c) {
    var age = now - c.t0;
    if (age > 1200) return;
    var from = fxPos(A, c.id);
    if (!from) return;
    h += '<div class="chipfly" style="left:' + from.x + 'px;top:' + from.y + 'px;'
      + '--dx:' + Math.round(POT_AT.x - from.x) + 'px;--dy:' + Math.round(POT_AT.y - from.y) + 'px;'
      + 'animation:chipin 1.1s cubic-bezier(.3,.1,.3,1) both;animation-delay:-' + age + 'ms">'
      + '<i></i><b>' + kfmt(c.amount) + '</b></div>';
  });
  return h;
}

function fxHtml(A) {
  var live = S.fxLive || [];
  if (!live.length) return '';
  var now = Date.now(), keep = [], h = '';
  live.forEach(function (f) {
    var age = now - f.t0;
    if (age > 3400) return;
    keep.push(f);
    var a = f.from ? fxPos(A, f.from) : null;
    var b = f.to ? fxPos(A, f.to) : null;
    if (f.from && f.to) {
      if (!a || !b) return;
      h += '<div class="fx" style="left:' + a.x + 'px;top:' + a.y + 'px;--dx:' + (b.x - a.x) + 'px;--dy:' + (b.y - a.y)
        + 'px;animation:fxfly .7s ease-in both;animation-delay:-' + age + 'ms">' + f.icon + '</div>';
      if (f.hit) h += '<div class="fx" style="left:' + b.x + 'px;top:' + b.y + 'px;font-size:40px;animation:fxpop 1.3s ease-out both;animation-delay:' + (700 - age) + 'ms">' + f.hit + '</div>';
    } else {
      var at = b || a;
      if (!at) return;
      h += '<div class="fx fxbub" style="left:' + at.x + 'px;top:' + (at.y - 42) + 'px;animation:fxbub 3s ease-out both;animation-delay:-' + age + 'ms">' + f.icon + '</div>';
    }
  });
  S.fxLive = keep;
  return h;
}
function fxTray(A) {
  if (!S.fxMenu || !fxCanPlay(A) || !S.v.reactions) return '';
  var own = S.fxMenu === 'me';
  var who = own ? null : A.seats.filter(function (x) { return x && x.id === S.fxMenu; })[0];
  if (!own && !who) return '';
  var list = own ? S.v.reactions.faces : S.v.reactions.throws;
  var h = '<div class="abs" style="inset:0;z-index:60;background:rgba(5,7,6,.55)" onclick="S.fxMenu=null;render()"></div>'
    + '<div class="abs" style="left:14px;right:14px;bottom:18px;z-index:61;background:#141917;border:1px solid #2a312d;border-radius:16px;padding:14px">'
    + '<div style="font-size:13px;font-weight:600;margin-bottom:10px">' + (own ? 'Put something up' : 'Throw something at ' + esc(who.name)) + '</div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:8px">';
  list.forEach(function (r) {
    h += '<button class="fxbtn" onclick="fxSend(\'' + r.k + '\'' + (own ? '' : ',\'' + S.fxMenu + '\'') + ')">' + r.icon + '</button>';
  });
  return h + '</div><button class="btn ghost" style="margin-top:12px" onclick="S.fxMenu=null;render()">Close</button></div>';
}

// ---- one seat ----
function plaque(A, st, x, y, w, rel, hand, RES, n, up) {
  var out = (st.away || st.busted || st.folded || (!st.inHand && hand && !hand.finished));
  var cls = 'seat ' + (up ? 'up' : 'low') + (st.isTurn ? ' turn' : '') + (out ? ' out' : '') + (st.allIn ? ' allin' : '') + (st.wants ? ' wants' : '');
  var line2 = st.allIn ? '<div class="pill" style="margin-top:3px;background:#d2454d;color:#fff">ALL IN</div>'
    : st.busted ? '<div class="sname">Out</div>'
    : st.away ? '<div class="sname">Away</div>'
    : st.folded ? '<div class="sname">Folded</div>'
    : '<div class="sname">' + esc(st.name) + '</div>';
  var bull = (fxCanPlay(A) && rel !== 0) ? '<span class="bull" onclick="fxOpen(\'' + st.id + '\')">' + bullSvg() + '</span>' : bullSvg();
  // what he just did, for a moment, so you can follow the betting without watching every chip
  var flash = (S.flash && S.flash.id === st.id && Date.now() < S.flash.until)
    ? '<div class="actflash">' + esc(S.flash.word) + '</div>' : '';
  // at a showdown the cards come up on their own; otherwise only what they chose to show
  var atShowdown = RES && st.cards && st.cards.length && st.cards[0] !== '??';
  var cards = atShowdown ? st.cards : (st.shown || null);
  var bar = st.isTurn && hand && hand.deadline
    ? '<span class="tring" id="tb' + st.id + '"></span><span class="tsec" id="ts' + st.id + '" style="display:none"></span>' : '';
  return '<div class="abs ' + cls + '" style="left:' + x + 'px;top:' + y + 'px;width:' + w + 'px">'
    + flash
    + '<div class="av' + (flash ? ' acted' : '') + '">' + initials(st.name) + bull + bar
      + (st.isButton ? '<span class="badge">D</span>' : '')
      + (st.wants ? '<span class="want">!</span>' : '') + '</div>'
    + line2 + '<div class="sstack">' + fmt(st.stack) + '</div>'
    + (n >= 7 && (rel === 1 || rel === n - 1) ? '' : behindTag(st))
    + (st.bet > 0 ? '<div class="betchip"><i></i>' + fmt(st.bet) + '</div>' : '')
    + (cards ? '<div class="showc">' + cards.map(function (c) { return card(c, 'md'); }).join('') + '</div>' : '')
    + '</div>';
}

// ---- the one seam: the rebuilt portal's view, in the shape the screen above expects ----
function adapt(v) {
  var n = v.seatsMax, hand = v.hand;
  var hp = {};
  if (hand) (hand.players || []).forEach(function (p) { hp[p.id] = p; });
  var seats = [];
  for (var s = 0; s < n; s++) {
    var st = v.seats[s];
    if (!st) { seats.push(null); continue; }
    var p = hp[st.id] || null;
    seats.push({
      id: st.id, seat: s, name: st.name, stack: st.stack, bought: st.bought,
      away: st.away, busted: st.busted, wants: !!(st.leaveAsk && !st.leaveOk),
      bet: p ? p.bet : 0, folded: p ? p.folded : false, allIn: p ? p.allIn : false,
      inHand: !!p, cards: p ? p.cards : null, shown: p ? p.shown : null, willShow: p ? (p.willShow || []) : [],
      isTurn: !!(hand && hand.turnId === st.id && !hand.finished),
      isButton: !!(hand && hand.button === s),
    });
  }
  return {
    code: v.code, handNo: v.handNo, seats: seats, hand: hand,
    you: { id: v.me ? v.me.id : '', seat: v.me ? v.me.seat : -1, watching: !v.me },
  };
}

function tableScreen() {
  var v = S.v;
  if (!v) return '<div class="sheet"><div class="muted" style="margin-top:40px">Opening the table…</div></div>';
  var A = adapt(v), hand = v.hand, n = A.seats.length, me = A.you;
  if (S.peekHand !== v.handNo) { S.peekHand = v.handNo; S.lock = false; S.peek = false; }

  var h = '<div class="abs" style="inset:0;background:#0a0c0b">';
  // the strip across the top
  h += '<div class="abs tbar" style="left:0;top:0;width:390px;height:56px;padding:0 8px 0 12px;display:flex;align-items:center;gap:10px">'
    + '<button class="rolechip" style="height:28px;flex:none" onclick="leaveTable()">&#8592;</button>'
    + '<div style="flex:1;min-width:0"><div class="gold" style="font-size:11px;font-weight:600;letter-spacing:.14em">ROOM ' + esc(v.code) + '</div>'
    + '<div class="muted" style="margin-top:2px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
    + (v.handNo ? 'Hand ' + v.handNo : 'Not started') + ' &middot; ' + esc(v.formatName)
    + (v.lastHands ? ' &middot; <span class="gold">' + v.lastHands + ' to go</span>'
       : v.endAt ? ' &middot; <span class="gold">till ' + clock(v.endAt) + '</span>' : '')
    + '</div></div>'
    + '<div style="height:28px;padding:0 12px;border-radius:14px;border:1px solid #2a312d;background:#141917;font-size:13px;font-weight:600;display:flex;align-items:center;flex:none">'
    + fmt(v.blinds.sb) + ' / ' + fmt(v.blinds.bb) + '</div>'
    // Sound is the one setting you reach for mid-hand - the room got loud, or somebody is asleep
    // next door - so it sits on the table itself rather than behind the menu.
    + '<button class="rolechip" style="height:30px;flex:none;width:34px;padding:0;font-size:15px'
    + (LOUD ? '' : ';opacity:.45') + '" title="' + (LOUD ? 'Sound on' : 'Sound off') + '" onclick="toggleSound()">'
    + (LOUD ? '&#128266;' : '&#128263;') + '</button>'
    + '<button class="rolechip" style="height:30px;flex:none" onclick="S.menu=!S.menu;render()">&#9776;</button></div>';

  // the felt, and your own half below it
  h += '<div class="abs felt" style="left:30px;top:106px;width:330px;height:240px"></div>';
  h += '<div class="abs" style="left:0;top:' + MINE + 'px;width:390px;height:' + (844 - MINE) + 'px;background:linear-gradient(#18231d,#0c110f 62%);border-top:2px solid #d8b45c"></div>';

  // the pot
  h += '<div class="abs" style="left:0;top:152px;width:390px;display:flex;flex-direction:column;align-items:center">'
    + '<div style="font-size:11px;font-weight:600;letter-spacing:.16em;color:#bfe0cf">POT</div>'
    + '<div class="disp gold" style="font-size:38px;line-height:1">' + fmt(hand ? hand.pot : 0) + '</div></div>';

  // which cards made the winning hand, so the rest can be dimmed
  var RES = (hand && hand.finished && hand.result) ? hand.result : null;
  S.win = null;
  if (RES && !RES.uncontested && RES.reveal) {
    S.win = {};
    Object.keys(RES.won || {}).forEach(function (id) {
      var r = RES.reveal[id];
      if (r && r.best) r.best.forEach(function (c) { S.win[c] = 1; });
    });
  }

  // the board: five places, filled as the cards come
  var boards = (hand && hand.boards && hand.boards.length) ? hand.boards : [[]];
  var multi = boards.length > 1, bc = '', i;
  if (!multi) {
    for (i = 0; i < 5; i++) bc += boards[0][i] ? card(boards[0][i], (S.win && !S.win[boards[0][i]]) ? 'dim' : '') : '<div class="card empty"></div>';
    h += '<div class="abs board" style="left:0;top:206px;width:390px;display:flex;justify-content:center;gap:5px">' + bc + '</div>';
  } else {
    boards.forEach(function (b) {
      bc += '<div class="board" style="display:flex;gap:3px;justify-content:center">';
      for (var j = 0; j < 5; j++) bc += b[j] ? card(b[j], 'sm' + ((S.win && !S.win[b[j]]) ? ' dim' : '')) : '<div class="card sm empty"></div>';
      bc += '</div>';
    });
    h += '<div class="abs" style="left:0;top:198px;width:390px;display:flex;flex-direction:column;gap:4px">' + bc + '</div>';
  }

  // what just happened, under the board
  var stTop = multi ? 198 + boards.length * 38 + 2 : 272;
  var status = '';
  if (RES) {
    status = Object.keys(RES.won || {}).map(function (id) {
      var st = A.seats.filter(function (x) { return x && x.id === id; })[0];
      var r = RES.reveal && RES.reveal[id];
      // on three flops the pot is won on points, so say what the boards came to - otherwise
      // the one line everybody reads does not explain why the chips went where they did
      var pts = RES.points && RES.points[id];
      var tally = RES.points
        ? ' &middot; ' + (pts === Math.round(pts) ? pts : pts.toFixed(1).replace(/\.0$/, ''))
          + ' of ' + RES.boardsPlayed + ' boards'
        : (r && r.handName ? ' &middot; ' + esc(r.handName) : '');
      return (st ? esc(st.name) : 'Somebody') + ' wins ' + fmt(RES.won[id]) + tally;
    }).join('<br>');
  } else if (hand && !hand.finished) {
    status = (hand.runit ? 'RUN IT? VOTE' : (hand.street || '').toUpperCase())
      + (hand.variant && hand.variant !== 'holdem' ? '<br><span style="color:#d8b45c">' + esc(hand.variantName || '').toUpperCase() + '</span>' : '');
  } else {
    status = v.status === 'ended' ? 'THE GAME HAS ENDED' : (v.waiting ? esc(v.waiting) : 'WAITING TO START');
  }
  // The street name is short and sits on the felt where it belongs. The result of a hand is
  // not - "Vashanth wins 800 . High card" is wider than the gap between the seats - so it goes
  // in the clear band under the felt, where it has the whole width and covers nobody.
  // Only the middle column of the felt is clear - the seats own the sides and the band below -
  // so the words live there and wrap onto a second line rather than running under somebody.
  h += '<div class="abs" style="left:120px;top:' + stTop + 'px;width:150px;text-align:center">'
    + '<span class="handsay" style="display:inline-block;max-width:150px;font-size:12px;'
    + 'font-weight:600;letter-spacing:.06em;color:' + (RES ? '#d8b45c' : '#bfe0cf') + ';line-height:1.45;'
    + 'white-space:normal">' + status + '</span></div>';

  // everybody else, round the table
  for (var s = 0; s < n; s++) {
    var st = A.seats[s];
    var rel = (s - (me.seat < 0 ? 0 : me.seat) + n) % n;
    if (rel === 0 && !me.watching) continue;
    var pos = seatXY(rel, n);
    var px = Math.max(-2, Math.min(390 - 74, pos.x - 38)), py = pos.y - 30;
    if (!st) { h += '<div class="abs seat" style="left:' + px + 'px;top:' + py + 'px;width:74px;opacity:.22"><div class="av" style="border-style:dashed"></div></div>'; continue; }
    h += plaque(A, st, px, py, 74, rel, hand, RES, n, pos.y < CY);
  }

  // your own corner
  var my = me.seat >= 0 ? A.seats[me.seat] : null;
  if (my && my.cards && my.cards.length) {
    // Big enough to read at a glance - these are the only cards that matter to you, and squinting
    // at them is the one thing you do every single hand. Four and five card games fan tighter and
    // scale down so the whole hand still clears the plaque beside it.
    var cn = my.cards.length, stp = cn > 4 ? 46 : (cn > 2 ? 52 : 62), rot = cn > 4 ? 6 : (cn > 2 ? 7 : 11);
    var cw = (cn - 1) * stp + 86, sc = cn > 4 ? 0.66 : (cn > 2 ? 0.76 : 1);
    var shown = !!(S.peek || S.lock) || !!(RES && RES.reveal && RES.reveal[me.id]);
    h += '<div id="hero" class="abs' + (shown ? ' up' : '') + '" style="left:16px;top:414px;height:132px;width:' + cw
      + 'px;transform:scale(' + sc + ');transform-origin:0 0;' + (my.folded ? 'opacity:.35' : '') + '">'
      + my.cards.map(function (c, k) {
        return '<div class="abs" style="left:' + (k * stp) + 'px;top:6px;transform:rotate(' + ((k - (cn - 1) / 2) * rot) + 'deg)">'
          + '<div class="hc"><div class="hb">' + card('??', 'xl') + '</div><div class="hf">' + card(c, 'xl') + '</div></div></div>';
      }).join('') + '</div>';
  }
  if (my) h += plaque(A, my, 208, 436, 145, 0, hand, RES, n, false);
  if (fxCanPlay(A)) {
    h += '<div class="abs" style="left:306px;top:452px;width:40px;height:40px">'
      + '<div class="pmini" style="position:relative;width:40px;height:40px;border-radius:20px;background:#1b2a22;cursor:pointer" onclick="fxOpen(\'me\')">'
      + bullSvg() + '<span style="position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;justify-content:center;font-size:16px">🙂</span></div></div>';
  }

  h += actionPanel(v, A, RES);
  h += fxTray(A);
  h += sayBar();
  h += chipHtml(A);
  h += fxHtml(A);
  if (S.menu) h += tableMenu(v);
  return h + '</div>';
}

// ---- the band at the bottom ----
function actionPanel(v, A, RES) {
  var h = '<div class="abs" style="left:0;top:586px;width:390px;height:258px;border-top:2px solid #d8b45c;background:#0a0c0b;padding:0 14px;overflow:auto">';
  h += controls(v, A, RES);
  return h + '</div>';
}

function controls(v, A, RES) {
  if (v.status === 'ended') return '<div style="padding-top:18px"><button class="btn" onclick="leaveTable()">Back to the tables</button></div>';
  // Paused: the clock is off and no hand is coming until whoever runs it says so. Say that plainly
  // rather than leaving people looking at buttons that will not work.
  if (v.paused) {
    return '<div style="padding-top:14px"><div class="evc" style="margin:0;border-color:#d8b45c">'
      + '<div style="font-weight:600;font-size:15px" class="gold">The game is paused</div>'
      + '<div class="muted small" style="white-space:normal;margin-top:3px">Nobody is on the clock and no hand will be dealt. '
      + esc(v.admin) + ' can start it again.</div></div>'
      + (v.iRunIt ? '<button class="btn" style="margin-top:10px" onclick="pauseGame(false)">Start the game again</button>' : '')
      + '</div>';
  }
  // Somebody who walked in to look rather than to play. Without this he falls through to the
  // betting controls and is told to wait for the others, which he is not doing at all - he has no
  // seat and no chips in this game.
  if (!v.me) {
    var free = 0;
    for (var i = 0; i < v.seatsMax; i++) if (!v.seats[i]) free++;
    var h = '<div style="padding-top:14px"><div class="evc" style="margin:0">'
      + '<div style="font-weight:600;font-size:14px">You are watching</div>'
      + '<div class="muted small" style="white-space:normal;margin-top:3px">No seat and no chips here yet. '
      + (free ? 'There ' + (free === 1 ? 'is one seat' : 'are ' + free + ' seats') + ' free.' : 'Every seat is taken.')
      + '</div></div>';
    if (free) {
      h += '<button class="btn" style="margin-top:10px" onclick="sitHere()">'
        + (v.status === 'playing' ? 'Ask for a seat' : 'Take a seat') + '</button>';
    }
    return h + '<button class="btn ghost" style="margin-top:8px" onclick="leaveTable()">Back to the tables</button></div>';
  }
  if (v.status !== 'playing' || !v.hand) {
    var w = '<div style="padding-top:18px">';
    if (v.iRunIt) w += '<button class="btn" ' + (v.waiting ? 'disabled' : '') + ' onclick="startGame()">' + (v.waiting ? esc(v.waiting) : 'Start now') + '</button>';
    else w += '<div class="evc" style="margin:0"><div class="muted small">' + (v.waiting ? esc(v.waiting) : 'Waiting for ' + esc(v.admin) + ' to start') + '</div></div>';
    return w + '</div>';
  }
  if (v.hand.runit) return '<div style="padding-top:14px">' + runItVote(v) + '</div>';

  // sat out, by choice or because a clock ran out while the phone was away
  if (v.me && v.me.away) {
    return '<div style="padding-top:14px">'
      + '<div class="evc" style="margin:0"><div style="font-weight:600;font-size:14px">You are sitting out</div>'
      + '<div class="muted small" style="white-space:normal;margin-top:3px">Your seat and your chips are being kept. '
      + 'You are not in the hand being played and no blinds are coming off you.</div></div>'
      + '<button class="btn" style="margin-top:10px" onclick="setAway(false)">Join the next hand</button></div>';
  }

  // the hand is over: offer to show what you had
  if (v.hand.finished) {
    return '<div style="padding-top:14px"><div class="evc" style="margin:0"><div class="muted small">Hand over</div></div>' + showRow(v, A) + '</div>';
  }

  var L = v.legal;
  if (!L) return '<div style="padding-top:22px"><div class="evc" style="margin:0"><div class="muted small">Waiting for the others</div></div>' + showRow(v, A) + '</div>';

  var min = L.minRaiseTo, max = L.maxRaiseTo;
  var cur = (S.raiseTo && S.raiseTo >= min && S.raiseTo <= max) ? S.raiseTo : min;
  var h = '<div style="padding-top:14px;display:flex;align-items:baseline;justify-content:space-between">'
    + '<div class="gold" style="font-size:12px;font-weight:700;letter-spacing:.14em">YOUR TURN</div>'
    + (L.canRaise ? '<div style="display:flex;align-items:baseline;gap:8px"><span class="muted" style="font-size:13px">Raise to</span>'
      + '<span class="disp" id="rv" style="font-size:26px">' + fmt(cur) + '</span></div>' : '') + '</div>';
  if (L.canRaise) {
    h += '<input type="range" style="margin-top:8px" min="' + min + '" max="' + max + '" step="1" value="' + cur + '" oninput="onRange(this.value)">';
    // A pot-sized raise is not the pot. You call first, and then raise by the pot as it stands
    // after that call - so with 300 in the middle and 200 to call, a pot raise is to 700, not 300.
    // Taking the raw pot figure put every one of these buttons below the minimum raise, where they
    // all collapsed onto the same number and the sizing did nothing at all.
    var potTo = function (f) {
      var after = L.pot + L.toCall;
      return Math.min(max, Math.max(min, Math.round(L.myBet + L.toCall + f * after)));
    };
    h += '<div style="display:flex;gap:6px;margin-top:8px">'
      + quick('½ pot', potTo(0.5))
      + quick('¾ pot', potTo(0.75))
      + quick('Pot', potTo(1))
      // in pot-limit the pot IS the ceiling, so an "all in" button would be the same button twice
      + (L.potLimit ? '' : quick('All in', max)) + '</div>';
  }
  h += '<div style="display:flex;gap:8px;margin-top:10px">'
    + '<button class="act" style="flex:1;background:#2a1e20" onclick="act(\'fold\')">Fold</button>'
    + (L.canCheck ? '<button class="act" style="flex:1;background:#1f3328" onclick="act(\'check\')">Check</button>'
      : '<button class="act" style="flex:1;background:#1f3328" onclick="act(\'call\')">Call ' + fmt(L.toCall || 0) + '</button>')
    + (L.canRaise ? '<button class="act" id="rb" style="flex:1;background:#d8b45c;color:#14110a" onclick="act(\'raise\',S.raiseTo||' + min + ')">Raise ' + fmt(cur) + '</button>' : '')
    + '</div>';
  h += '<div class="muted" style="margin-top:6px;text-align:center;font-size:11px">No-limit &middot; minimum raise to ' + fmt(min) + '</div>';
  return h;
}

function onRange(x) {
  S.raiseTo = Number(x);
  var e = document.getElementById('rv'); if (e) e.textContent = fmt(S.raiseTo);
  var b = document.getElementById('rb'); if (b) b.textContent = 'Raise ' + fmt(S.raiseTo);
}
function quick(label, amount) {
  return '<button class="chip" style="flex:1" onclick="S.raiseTo=' + amount + ';render()">' + label + '</button>';
}

// ---- showing your cards when nobody made you ----
function showRow(v, A) {
  var my = A.you.seat >= 0 ? A.seats[A.you.seat] : null;
  if (!my || !my.inHand || !my.cards || !my.cards.length || my.cards[0] === '??') return '';
  var sh = my.willShow || [], cn = my.cards.length;
  var cs = my.cards.map(function (c, i) {
    var on = sh.indexOf(i) >= 0;
    return '<button onclick="showCard(' + i + ')" style="padding:3px;border-radius:8px;background:' + (on ? 'rgba(216,180,92,.25)' : 'transparent')
      + ';border:1px solid ' + (on ? '#d8b45c' : '#2a312d') + '">' + card(c, 'sm') + '</button>';
  }).join('');
  var nOn = sh.length;
  return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:10px;border:1px dashed #2a312d;margin-top:10px">'
    + '<div style="flex:1;min-width:100px"><div class="gold" style="font-weight:700;letter-spacing:.08em;font-size:11px;white-space:nowrap">SHOW YOUR CARDS</div>'
    + '<div class="muted" style="font-size:11px">' + (nOn ? 'Turned over when the hand ends' : 'Tap a card to show it') + '</div></div>'
    + '<div style="display:flex;gap:4px;flex:none">' + cs + '</div>'
    + (cn > 1 ? '<button class="btn ghost" style="flex:none;width:auto;height:34px;padding:0 10px;font-size:12px" onclick="showCard(\'all\')">' + (nOn === cn ? 'Hide' : 'All') + '</button>' : '')
    + '</div>';
}
function showCard(i) {
  var A = adapt(S.v), my = A.seats[A.you.seat];
  if (!my || !my.cards) return;
  var cn = my.cards.length;
  var cur = (my.willShow || []).slice();
  var idx;
  if (i === 'all') idx = cur.length === cn ? [] : my.cards.map(function (c, k) { return k; });
  else idx = cur.indexOf(i) >= 0 ? cur.filter(function (k) { return k !== i; }) : cur.concat([i]);
  api('showcards', { code: S.code, idx: idx }).catch(fail);
}

// Taking a seat from inside the room: you are already looking at the table, so stay on it whether
// the seat is yours straight away or the admin has to let you in.
function sitHere() {
  api('table-join', { code: S.code })
    .then(function (j) { toast(j.seated ? 'You are in' : 'Asked. ' + S.v.admin + ' will let you know.'); return refresh(); })
    .catch(fail);
}

function act(type, amount) {
  api('act', { code: S.code, type: type, amount: amount }).catch(fail);
}
function startGame() { api('table-start', { code: S.code }).catch(fail); }
function setAway(on) { api('away', { code: S.code, on: on }).catch(fail); }

function tableMenu(v) {
  var h = '<div class="sheet" style="z-index:40"><div style="display:flex;justify-content:space-between;align-items:center">'
    + '<div class="disp" style="font-size:26px">' + esc(v.formatName) + '</div>'
    + '<button class="rolechip" onclick="S.menu=false;render()">Close</button></div>'
    + '<div class="muted small">Table ' + esc(v.code) + ' &middot; run by ' + esc(v.admin) + (v.variantName ? ' &middot; ' + esc(v.variantName) : '') + '</div>';

  h += '<button class="btn ghost" style="margin-top:12px" onclick="S.menu=false;S.rules=\'' + v.code + '\';render()">House rules</button>';
  if (v.nextVariant) h += '<div class="pass" style="margin-top:12px"><div class="gold" style="font-size:11px;font-weight:700;letter-spacing:.14em">NEXT HAND</div><div style="font-size:15px;margin-top:2px">' + esc(v.nextVariant) + '</div></div>';

  // what a player can do
  if (v.me) {
    h += '<div class="h2">YOU</div>';
    if (v.format !== 'tournament') {
      h += '<div style="display:flex;gap:8px"><input id="bi_amt" inputmode="numeric" placeholder="' + fmt(v.settings.minBuyin) + '" style="flex:1;min-width:0;height:46px;border-radius:10px;border:1px solid #2a312d;background:#141917;color:#f2efe6;font-size:15px;padding:0 12px;font-family:inherit">'
        + '<button class="rolechip on" style="height:46px" onclick="doBuyin()">Buy in</button></div>';
      if (v.me.topUp) {
        h += '<div class="muted small" style="margin-top:6px;white-space:normal"><span class="gold">' + fmt(v.me.topUp)
          + '</span> goes on at the end of this hand.</div>';
      } else if (v.me.inPlay) {
        h += '<div class="muted small" style="margin-top:6px;white-space:normal">You are in a hand, so chips you buy now go on when it ends.</div>';
      }
      // topping up without having to ask each time
      h += '<div style="margin-top:10px">'
        + (v.me.auto
          ? '<div class="evc" style="margin:0;border-color:#d8b45c"><div class="gold" style="font-weight:600">Buying back in for ' + fmt(v.settings.minBuyin) + '</div>'
            + '<div class="muted small" style="white-space:normal;margin-top:3px">If your chips run out it goes on at the end of that hand, so you are dealt into the next one.</div></div>'
            + '<button class="btn ghost" style="margin-top:8px" onclick="autoBuyin(false)">Stop buying me back in</button>'
          : '<button class="btn ghost" onclick="autoBuyin(true)">Buy me back in if I run out</button>'
            + '<div class="muted small" style="margin-top:6px;white-space:normal">The buy-in this game was opened with: ' + fmt(v.settings.minBuyin) + '. Until you have chips you are dealt out.</div>')
        + '</div>';
    }
    h += '<button class="btn ghost" style="margin-top:8px" onclick="setAway(' + (v.me.away ? 'false' : 'true') + ')">' + (v.me.away ? 'Sit back in' : 'Sit out of the next hand') + '</button>';
    if (!v.iRunIt) {
      // what leaving actually costs you, before you tap it
      if (v.me.forfeit) {
        h += '<div class="evc" style="margin:10px 0 0;border-color:#6b2a2e"><div style="font-weight:600;color:#f08a8f">Paying your blinds out</div>'
          + '<div class="muted small" style="white-space:normal;margin-top:3px">You are not being dealt in. Your blinds go in without you until '
          + clock(v.me.freeAt) + ', and then you leave with what is left.</div></div>';
      } else if (v.me.canLeave) {
        h += '<button class="btn ghost" style="margin-top:8px" onclick="askLeave()">'
          + (v.me.stack <= 0 ? 'Leave the table' : 'Leave the table') + '</button>'
          + '<div class="muted small" style="margin-top:6px;white-space:normal">'
          + (v.me.stack <= 0 ? 'You have no chips left, so you are free to go.' : 'You have stayed the time, so you may go whenever you like.')
          + '</div>';
      } else if (v.me.asked) {
        h += '<div class="muted small" style="margin-top:8px;white-space:normal">You have asked ' + esc(v.admin) + ' if you can go early. Waiting on him.</div>';
      } else {
        h += '<button class="btn ghost" style="margin-top:8px" onclick="askLeave()">Ask to leave early</button>'
          + '<div class="muted small" style="margin-top:6px;white-space:normal">Everybody said they would stay until '
          + clock(v.me.freeAt) + '. Ask and ' + esc(v.admin) + ' decides; if he says no, your blinds keep going in without you until then.</div>';
      }
    }
  }

  h += '<div class="h2">THE TABLE</div>'
    + '<div style="display:flex;gap:6px;flex-wrap:wrap">';
  FELTS.forEach(function (f) {
    h += '<button class="rolechip' + ((S.felt || '') === f.id ? ' on' : '') + '" style="display:flex;align-items:center;gap:6px"'
      + ' onclick="setFelt(\'' + f.id + '\')">'
      + '<span style="width:12px;height:12px;border-radius:7px;background:' + f.dot + ';border:1px solid rgba(255,255,255,.25);display:inline-block"></span>'
      + f.name + '</button>';
  });
  h += '</div><div class="muted small" style="margin-top:6px;white-space:normal">Your own choice, on your own phone. Nobody else at the table sees it.</div>';

  h += '<div class="h2">SOUND</div>'
    + '<button class="btn ghost" onclick="toggleSound()">' + (LOUD ? 'Sound is on &mdash; turn it off' : 'Sound is off &mdash; turn it on') + '</button>'
    + '<div class="muted small" style="margin-top:6px;white-space:normal">A bell when it is your turn, a tick when it passes to somebody else, and the chips going in.</div>';

  // what the game admin can do
  if (v.iRunIt) {
    h += '<div class="h2">RUNNING THIS TABLE</div>';
    if (v.requests.length) {
      v.requests.forEach(function (r) {
        h += '<div class="row" style="margin-top:6px"><div style="flex:1;min-width:0">' + esc(r.name) + ' wants to come in</div>'
          + '<button class="rolechip on" onclick="decide(\'' + v.code + '\',\'' + r.memberId + '\',true)">Let in</button>'
          + '<button class="rolechip" style="color:#d2454d;border-color:#6b2a2e" onclick="decide(\'' + v.code + '\',\'' + r.memberId + '\',false)">No</button></div>';
      });
    }
    if (v.leaveAsks.length) {
      v.leaveAsks.forEach(function (p) {
        h += '<div class="row" style="margin-top:6px"><div style="flex:1;min-width:0">' + esc(p.name) + ' asks to leave early</div>'
          + '<button class="rolechip on" onclick="decideLeave(\'' + p.id + '\',true)">Let go</button>'
          + '<button class="rolechip" onclick="decideLeave(\'' + p.id + '\',false)">Stay</button></div>';
      });
    }
    if (!v.requests.length && !v.leaveAsks.length) h += '<div class="muted small">Nothing waiting on you.</div>';
    h += '<button class="btn ghost" style="margin-top:10px" onclick="getInvite(\'' + v.code + '\')">Invite message for the group</button>';
    h += '<button class="btn" style="margin-top:8px" onclick="pauseGame(' + (v.paused ? 'false' : 'true') + ')">'
      + (v.paused ? 'Start the game again' : 'Pause the game') + '</button>';
    h += '<div class="muted small" style="margin-top:6px;white-space:normal">'
      + (v.paused ? 'Nobody is on the clock and no hand will be dealt until you start it again.'
                  : 'Stops the clock and holds the next hand, so everyone can take a break. Nobody gets folded for being slow while it is paused.')
      + '</div>';
    h += '<div class="h2">WRAPPING UP</div>';
    if (v.lastHands) {
      h += '<div class="evc" style="margin:0;border-color:#d8b45c"><div class="gold" style="font-weight:600">'
        + v.lastHands + ' more hand' + (v.lastHands === 1 ? '' : 's') + ' to go</div>'
        + '<div class="muted small" style="white-space:normal;margin-top:3px">The game closes itself and works out the accounts when they are done.</div></div>'
        + '<button class="btn ghost" style="margin-top:8px" onclick="lastHands(0)">Carry on playing instead</button>';
    } else {
      h += '<div class="muted small" style="white-space:normal">Tell the table how many hands are left, so everybody knows where they stand before the night ends.</div>'
        + '<div style="display:flex;gap:8px;margin-top:8px">'
        + '<button class="rolechip" style="flex:1;height:42px" onclick="lastHands(5)">Last 5 hands</button>'
        + '<button class="rolechip" style="flex:1;height:42px" onclick="lastHands(10)">Last 10 hands</button></div>';
    }
    // or a time to finish, which does the same thing when it comes round
    if (v.endAt) {
      h += '<div class="evc" style="margin:10px 0 0;border-color:#d8b45c"><div class="gold" style="font-weight:600">Finishing at ' + clock(v.endAt) + '</div>'
        + '<div class="muted small" style="white-space:normal;margin-top:3px">The hand being played then is played out before the game closes.</div></div>'
        + '<button class="btn ghost" style="margin-top:8px" onclick="setEndAt(0)">No finishing time</button>';
    } else {
      h += '<div class="muted small" style="margin-top:10px;white-space:normal">Or say when the game finishes.</div>'
        + '<div style="display:flex;gap:8px;margin-top:8px">'
        + '<input id="nt_end" type="time" style="flex:1;min-width:0;height:44px;border-radius:10px;border:1px solid #2a312d;background:#141917;color:#f2efe6;font-size:15px;padding:0 10px;font-family:inherit">'
        + '<button class="rolechip on" style="height:44px" onclick="setEndAt()">Set</button></div>'
        + '<div style="display:flex;gap:8px;margin-top:8px">'
        + '<button class="rolechip" style="flex:1;height:38px;font-size:12px" onclick="setEndAt(Date.now()+30*60000)">+30 min</button>'
        + '<button class="rolechip" style="flex:1;height:38px;font-size:12px" onclick="setEndAt(Date.now()+60*60000)">+1 hour</button>'
        + '<button class="rolechip" style="flex:1;height:38px;font-size:12px" onclick="setEndAt(Date.now()+120*60000)">+2 hours</button></div>';
    }
    h += '<button class="btn ghost" style="margin-top:10px;border-color:#6b2a2e;color:#d2454d" onclick="endGame()">End the game</button>';
    h += '<div class="muted small" style="margin-top:6px;white-space:normal">Ending works out everyone’s account, says who pays who, and puts it in History.</div>';
  }

  if (v.notes && v.notes.length) {
    h += '<div class="h2">MESSAGES</div>';
    v.notes.slice().reverse().forEach(function (nt) {
      h += '<div class="row" style="margin-top:6px"><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600">' + esc(nt.name) + '</div><div class="muted small">' + esc(nt.text) + '</div></div><div class="muted small">' + clock(nt.at) + '</div></div>';
    });
  }
  h += '<div class="h2">SAY SOMETHING</div>';
  var list = (v.iRunIt ? ADMIN_SAYINGS.concat(SAYINGS) : SAYINGS);
  h += '<div style="display:flex;flex-direction:column;gap:6px">';
  list.forEach(function (sg) {
    h += '<button class="btn ghost" style="height:40px;font-size:13px;text-align:left;padding:0 12px"'
      + ' onclick="saySomething(\'' + sg.id + '\')">' + esc(sg.text) + (sg.acts ? ' <span class="gold">&bull;</span>' : '') + '</button>';
  });
  h += '</div><div class="muted small" style="margin-top:6px;white-space:normal">The ones marked <span class="gold">&bull;</span> do the thing as well as say it.</div>';

  h += '<div class="h2">WHAT HAPPENED</div><div class="muted small" style="line-height:1.7">'
    + v.log.slice().reverse().slice(0, 25).map(function (l) { return clock(l.at) + ' &middot; ' + esc(l.text); }).join('<br>') + '</div>';
  return h + '</div>';
}
function doBuyin() {
  blurField();
  var a = Number(val('bi_amt')) || S.v.settings.minBuyin;
  api('buyin', { code: S.code, amount: a })
    .then(function (j) { toast(j.waiting ? fmt(a) + ' goes on at the end of this hand' : 'Bought in for ' + fmt(a)); return refresh(); })
    .catch(fail);
}
function askLeave() {
  api('leave-ask', { code: S.code })
    .then(function (j) { toast(j.leaving ? 'You are out at the end of this hand' : 'Asked. ' + S.v.admin + ' will decide.'); return refresh(); })
    .catch(fail);
}
function decideLeave(pid, ok) { api('leave-decide', { code: S.code, playerId: pid, ok: ok }).then(function () { toast(ok ? 'They may go' : 'Asked to stay'); }).catch(fail); }
function lastHands(n) {
  api('table-last', { code: S.code, hands: n })
    .then(function (j) { S.menu = false; toast(j.lastHands ? 'Last ' + j.lastHands + ' hands' : 'Carrying on'); render(); })
    .catch(fail);
}
// A time typed as 1:15 on a poker night nearly always means tomorrow morning, so a time that has
// already gone today is taken as the small hours rather than refused.
function setEndAt(at) {
  if (at === undefined) {
    var el = document.getElementById('nt_end');
    var v = el && el.value;
    if (!v) { toast('Pick a time first'); return; }
    var bits = v.split(':');
    var d = new Date();
    d.setHours(Number(bits[0]), Number(bits[1]), 0, 0);
    if (d.getTime() < Date.now() + 30000) d.setDate(d.getDate() + 1);
    at = d.getTime();
  }
  api('table-endat', { code: S.code, at: at })
    .then(function (j) { S.menu = false; toast(j.endAt ? 'Finishing at ' + clock(j.endAt) : 'No finishing time'); render(); })
    .catch(fail);
}
function autoBuyin(on) {
  api('auto-buyin', { code: S.code, on: on })
    .then(function (j) { toast(j.auto ? 'Buying you back in for ' + fmt(j.amount) : 'Not buying back in'); return refresh(); })
    .catch(fail);
}
function pauseGame(on) {
  api('table-pause', { code: S.code, on: on })
    .then(function (j) { S.menu = false; toast(j.paused ? 'Paused' : 'Away we go'); render(); })
    .catch(fail);
}
// Closing a game cannot be undone, so it asks first - and says what will actually happen, which
// depends on whether anybody played. The browser's own confirm() box did ask, but it looks nothing
// like the portal, and on a phone it is small enough to tap past without reading.
function endGame() {
  var v = S.v || {};
  S.ask = {
    title: 'Close this game?',
    detail: !v.handNo
      ? 'No hand was dealt, so there is nothing to settle and nothing goes into History. Everyone keeps what they bought in with.'
      : (v.hand && !v.hand.finished && !v.paused)
        ? 'Hand ' + v.handNo + ' is still being played, so it will be played out first and the game closes when it ends. Nobody is cut off mid-hand. The accounts are then worked out and it goes into History.'
        : 'Hand ' + v.handNo + ' is as far as you got. Everyone\u2019s account is worked out, the portal says who pays who, and it goes into History. This cannot be undone.',
    yes: 'Yes, close it',
    go: 'doEndGame()',
  };
  S.menu = false;
  render();
}
function doEndGame() {
  S.ask = null;
  api('table-end', { code: S.code })
    .then(function (j) { toast(j.afterHand ? 'Closing when this hand ends' : 'Game closed'); refresh(); })
    .catch(fail);
}
function askSheet() {
  var a = S.ask;
  return '<div class="sheet" style="z-index:60"><div class="disp" style="font-size:26px">' + esc(a.title) + '</div>'
    + '<div class="muted small" style="margin-top:8px;white-space:normal">' + esc(a.detail) + '</div>'
    + '<button class="btn" style="margin-top:16px;background:#d2454d;color:#fff" onclick="' + a.go + '">' + esc(a.yes) + '</button>'
    + '<button class="btn ghost" style="margin-top:8px" onclick="S.ask=null;render()">Cancel</button></div>';
}


// ---------------------------------------------------------------- draw
// Which screen is on show. Used to decide whether a redraw is the same screen again - in which
// case whatever you had scrolled to is still what you want to be looking at.
function screenKey() {
  if (!S.token || !S.me) return 'signin';
  if (S.ask) return 'ask';
  if (S.book) return 'book';
  if (S.rules) return 'rules:' + S.rules;
  if (S.replay) return 'replay:' + S.replay.i;
  if (S.invite) return 'invite';
  if (S.screen === 'table') return 'table:' + S.code + (S.menu ? ':menu' : '');
  return 'home:' + (S.tab || '');
}

function render() {
  var keep = document.activeElement;
  if (keep && keep.id && /^(in_|ad_|am_|n_|bi_|nt_|cp_)/.test(keep.id)) {
    // never redraw out from under somebody who is typing
    var pending = render.pending;
    if (!pending) render.pending = setTimeout(function () { render.pending = null; }, 400);
    if (document.getElementById(keep.id)) return;
  }
  var html = !S.token || !S.me ? signInScreen()
    : S.ask ? askSheet()
    : S.book === 'portal' ? generalBook()
    : S.book ? gameBook()
    : S.rules ? rulesSheet()
    : S.replay ? replaySheet()
    : S.invite ? inviteSheet()
    : S.screen === 'table' ? tableScreen()
    : home();
  if (S.toast) html += '<div class="toast' + (S.toastBad ? '' : ' ok') + '">' + esc(S.toast) + '</div>';
  var stage = document.getElementById('stage');

  // Every screen scrolls, and the table redraws on its own each time somebody acts. Replacing the
  // page would send you back to the top mid-read, and stepping through a replay would jump away
  // from the buttons you are tapping. So remember where each pane was and put it back.
  var key = screenKey();
  var was = [].map.call(stage.querySelectorAll('.sheet'), function (el) { return el.scrollTop; });
  stage.innerHTML = html;
  applyFelt();
  if (key === render.key) {
    var panes = stage.querySelectorAll('.sheet');
    if (panes.length === was.length) for (var i = 0; i < panes.length; i++) if (was[i]) panes[i].scrollTop = was[i];
  }
  render.key = key;
  fit();
}

// The whole portal is drawn at 390x844 and scaled to the phone, so it looks the same everywhere.
//
// The position is worked out in pixels rather than with a percentage translate. A CSS percentage
// in translateX resolves against the element's own unscaled width, so on any phone that is not
// exactly 390 wide the page slid sideways - about 80px on a phone in Safari, enough to cut the
// title off. Everything is placed against the safe area too, so nothing hides under the notch,
// the Dynamic Island or the home bar.
function inset() {
  var el = document.getElementById('safe');
  if (!el) return { t: 0, r: 0, b: 0, l: 0 };
  var cs = getComputedStyle(el);
  var n = function (v) { var x = parseFloat(v); return x > 0 ? x : 0; };
  return { t: n(cs.paddingTop), r: n(cs.paddingRight), b: n(cs.paddingBottom), l: n(cs.paddingLeft) };
}

function fit() {
  var pad = inset();
  var w = Math.max(1, window.innerWidth - pad.l - pad.r);
  var h = Math.max(1, window.innerHeight - pad.t - pad.b);

  // Sideways on a phone there is so little height left that the type comes out at about 4px.
  // Ask for the phone upright instead. A tablet on its side has room, so it carries on.
  var turn = document.getElementById('turn');
  if (turn) turn.style.display = (w > h && h < 500) ? 'flex' : 'none';

  var scale = Math.min(w / 390, h / 844);
  var wrap = document.getElementById('wrap');
  wrap.style.transform = 'scale(' + scale + ')';
  wrap.style.left = Math.round(pad.l + (w - 390 * scale) / 2) + 'px';
  wrap.style.top = Math.round(pad.t + Math.max(0, (h - 844 * scale) / 2)) + 'px';
}
window.addEventListener('resize', fit);
window.addEventListener('orientationchange', function () { setTimeout(fit, 120); });

// ---------------------------------------------------------------- go
// ---- the celebration ----
// A hand worth looking up from your phone for gets the sky. Particles on a canvas rather than a
// pile of DOM nodes: a few hundred specks at sixty frames a second would bring a phone to its
// knees as elements, and the canvas sits outside the part of the page that redraws every time
// somebody acts, so a bet landing mid-burst does not wipe it away.
var SKY = { on: false, parts: [], until: 0, raf: 0 };
var SKY_COLOURS = ['#f7d774', '#ff8f6b', '#8fd9ff', '#c7a6ff', '#9bf0b0', '#ffffff'];

function burst(x, y, n, power) {
  var colour = SKY_COLOURS[Math.floor(Math.random() * SKY_COLOURS.length)];
  for (var i = 0; i < n; i++) {
    var a = Math.random() * Math.PI * 2, sp = (0.35 + Math.random()) * power;
    SKY.parts.push({
      x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 900 + Math.random() * 700, age: 0,
      c: Math.random() < 0.18 ? '#ffffff' : colour, r: 1.3 + Math.random() * 1.9,
    });
  }
}

function skyFrame(last) {
  var cv = document.getElementById('sky');
  if (!cv) { SKY.on = false; return; }
  var g = cv.getContext('2d'), now = Date.now(), dt = Math.min(48, now - last);
  g.clearRect(0, 0, 390, 844);
  var alive = [];
  for (var i = 0; i < SKY.parts.length; i++) {
    var p = SKY.parts[i];
    p.age += dt;
    if (p.age >= p.life) continue;
    p.x += p.vx * dt * 0.06;
    p.y += p.vy * dt * 0.06;
    p.vy += dt * 0.0022;                    // gravity, so they arc and fall like real ones
    p.vx *= 0.995; p.vy *= 0.995;
    var fade = 1 - p.age / p.life;
    g.globalAlpha = fade;
    g.fillStyle = p.c;
    g.beginPath(); g.arc(p.x, p.y, p.r * fade + 0.4, 0, 6.3); g.fill();
    alive.push(p);
  }
  g.globalAlpha = 1;
  SKY.parts = alive;
  if (!alive.length && now > SKY.until) {
    cv.style.display = 'none';
    var sh = document.getElementById('shout');
    if (sh) { sh.style.display = 'none'; sh.innerHTML = ''; }
    SKY.on = false;
    return;
  }
  SKY.raf = requestAnimationFrame(function () { skyFrame(now); });
}

// how big a moment it is: 1 a good pot, 2 a monster
function celebrateSky(level, title, who) {
  var cv = document.getElementById('sky');
  if (!cv) return;
  cv.style.display = 'block';
  var sh = document.getElementById('shout');
  if (sh && title) {
    // FOUR OF A KIND is more than twice as wide as QUADS and the banner has 362px to live in, so
    // the lettering is cut to fit rather than running off both edges of the phone.
    var size = title.length > 13 ? 30 : title.length > 10 ? 36 : title.length > 7 ? 42 : 46;
    sh.innerHTML = '<span class="big" style="font-size:' + size + 'px">' + esc(title) + '</span>'
      + (who ? '<span class="who">' + esc(who) + '</span>' : '');
    sh.style.display = 'block';
  }
  var shots = level > 1 ? 5 : 3;
  for (var i = 0; i < shots; i++) {
    (function (k) {
      setTimeout(function () {
        if (!SKY.on) return;
        burst(60 + Math.random() * 270, 120 + Math.random() * 260, level > 1 ? 70 : 46, level > 1 ? 2.3 : 1.8);
        sfx('bang');
      }, k * (level > 1 ? 280 : 340));
    }(i));
  }
  SKY.until = Date.now() + shots * 340 + 900;
  if (!SKY.on) { SKY.on = true; skyFrame(Date.now()); }
}

// ---- how the table is dressed ----
// One person's choice, kept on their own phone: two people at the same table can be looking at
// different cloth and neither is wrong. It is set on the stage rather than written into the table
// so a redraw cannot lose it.
var FELTS = [
  { id: '', name: 'Emerald', dot: '#1a6a4d' },
  { id: 'midnight', name: 'Midnight', dot: '#24507f' },
  { id: 'claret', name: 'Claret', dot: '#7a2634' },
];
try { S.felt = localStorage.getItem('sb-felt') || ''; } catch (e) { S.felt = ''; }
function applyFelt() {
  var st = document.getElementById('stage');
  if (!st) return;
  if (S.felt) st.setAttribute('data-felt', S.felt); else st.removeAttribute('data-felt');
}
function setFelt(id) {
  S.felt = id || '';
  try { localStorage.setItem('sb-felt', S.felt); } catch (e) {}
  applyFelt();
  render();
}

// ---- sound ----
// Made on the phone rather than fetched: a few short tones weigh nothing, load instantly and
// cannot fail halfway. A phone will not make a sound until the person has touched the screen, so
// the first touch opens the audio and everything before that is silent on purpose.
var AC = null, LOUD = true;
try { LOUD = localStorage.getItem('sb-quiet') !== '1'; } catch (e) {}
function unlockSound() {
  if (!AC) { var C = window.AudioContext || window.webkitAudioContext; if (C) { try { AC = new C(); } catch (e) { AC = null; } } }
  if (AC && AC.state === 'suspended') { try { AC.resume(); } catch (e) {} }
}
document.addEventListener('touchstart', unlockSound, { passive: true });
document.addEventListener('click', unlockSound, { passive: true });
function tone(freq, dur, vol, shape, wait) {
  if (!LOUD || !AC || AC.state !== 'running') return;
  try {
    var t0 = AC.currentTime + (wait || 0);
    var o = AC.createOscillator(), g = AC.createGain();
    o.type = shape || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(AC.destination);
    o.start(t0); o.stop(t0 + dur + 0.03);
  } catch (e) { /* a phone that will not make a sound is not a reason to stop the game */ }
}
function sfx(kind) {
  if (!LOUD) return;
  unlockSound();
  if (kind === 'mine') { tone(880, 0.20, 0.25); tone(1320, 0.28, 0.20, 'sine', 0.14); }   // your turn: two notes, unmistakable
  else if (kind === 'pass') tone(430, 0.07, 0.07, 'triangle');                             // it has moved on to somebody else
  else if (kind === 'chip') tone(1150, 0.05, 0.07, 'square');                              // chips going in
  else if (kind === 'over') { tone(660, 0.13, 0.15); tone(520, 0.20, 0.12, 'sine', 0.11); }
  else if (kind === 'bang') { tone(150, 0.26, 0.20, 'triangle'); tone(90, 0.34, 0.16, 'sine', 0.02); }
}
function toggleSound() {
  LOUD = !LOUD;
  try { localStorage.setItem('sb-quiet', LOUD ? '0' : '1'); } catch (e) {}
  if (LOUD) { unlockSound(); sfx('pass'); }
  render();
}

// ---- whose turn it is, out loud ----
// The bell is for your turn and nothing else, so it keeps meaning something. Everyone else moving
// gets a tick, which is enough to follow the betting with the phone face down on the table.
function watchTurn() {
  var h = S.v && S.v.hand;
  var id = h && !h.finished ? h.turnId : '';
  var done = !!(h && h.finished);
  if (done !== !!S.overSeen) { S.overSeen = done; if (done && S.turnSeen) sfx('over'); }
  if (id === S.turnSeen) return;
  var first = S.turnSeen === undefined;
  S.turnSeen = id;
  if (first || !id) return;                 // arriving at a table is not the turn changing
  sfx(S.v.me && id === S.v.me.id ? 'mine' : 'pass');
}

// ---- what people say to each other ----
// A short list, no typing. Sending one is a tap, and what arrives sits across the bottom of the
// table for a few seconds and then goes. Anything older lives in the menu for whoever wants it.
var SAYINGS = [
  { id: 'five', text: 'Back in five minutes' },
  { id: 'deal', text: 'Deal me out a hand or two' },
  { id: 'backin', text: "I'm back - deal me in" },
  { id: 'slow', text: 'My connection is poor' },
  { id: 'oneorbit', text: 'One more orbit and I am done' },
  { id: 'nice', text: 'Nice hand' },
  { id: 'pausepls', text: 'Can we take a short break?' },
  { id: 'leave', text: 'I need to leave early', acts: true },
  { id: 'topup', text: 'Buy me back in if I run out', acts: true },
];
var ADMIN_SAYINGS = [
  { id: 'soon', text: 'Starting in a minute' },
  { id: 'yours', text: 'Your turn - are you there?' },
  { id: 'brk', text: 'Taking a short break' },
  { id: 'wrap', text: 'We are wrapping up soon' },
  { id: 'paypls', text: 'Please settle up when you can' },
];
var SAY_FOR_MS = 5000;

function saySomething(id) {
  api('say', { code: S.code, id: id })
    .then(function (j) { S.menu = false; toast(j.said || 'Sent'); return refresh(); })
    .catch(fail);
}

// Anything that arrived since last time, shown once. The seen mark is what stops a message
// reappearing on every redraw for as long as it is in the last ten.
function watchSaid() {
  var notes = (S.v && S.v.notes) || [];
  // Opening the table is not everybody talking to you at once. Whatever was said before you got
  // here is already in the menu; only what arrives from now on comes across the bottom.
  if (!S.saidSeen) {
    S.saidSeen = {};
    notes.forEach(function (n) { S.saidSeen[n.id] = 1; });
    return;
  }
  if (!notes.length) return;
  // Messages are addressed to a member, not to a seat: the same person has a different seat id at
  // every table, and whoever runs a table may not be sitting at it at all.
  var me = S.v.me || {};
  var fresh = notes.filter(function (n) {
    if ((S.saidSeen || {})[n.id]) return false;
    if (n.from === (S.me && S.me.id)) return false;      // not your own words back at you
    if (!n.to) return true;                              // said to the table
    return n.to === (S.me && S.me.id) || n.to === me.memberId;
  });
  S.saidSeen = S.saidSeen || {};
  notes.forEach(function (n) { S.saidSeen[n.id] = 1; });
  if (!fresh.length) return;
  S.sayQ = (S.sayQ || []).concat(fresh);
  if (!S.sayShow) nextSaid();
}
// one at a time, in the order they arrived, so two together do not sit on top of each other
function nextSaid() {
  var q = S.sayQ || [];
  if (!q.length) { S.sayShow = null; if (S.screen === 'table') render(); return; }
  S.sayShow = q.shift();
  S.sayQ = q;
  if (S.screen === 'table') render();
  clearTimeout(nextSaid.t);
  nextSaid.t = setTimeout(nextSaid, SAY_FOR_MS);
}
function sayBar() {
  var m = S.sayShow;
  if (!m) return '';
  return '<div class="saybar"><div class="who">' + esc(m.fromName || '') + '</div>'
    + '<div class="what">' + esc(m.text) + '</div></div>';
}

// ---- the move just made ----
// Every view carries the last move and a running count of moves. When the count moves on, that is
// somebody acting: say so on their seat for a second. Folding is not flashed - the seat already
// says Folded, and says it until the hand is over.
var ACT_WORD = { call: 'CALL', bet: 'BET', raise: 'RAISE', check: 'CHECK', allin: 'ALL IN' };
function watchActs() {
  var h = S.v && S.v.hand, la = h && h.lastAct;
  if (!la) { S.actSeen = 0; return; }
  if (la.n === S.actSeen) return;
  var first = !S.actSeen;
  S.actSeen = la.n;
  if (first) return;                         // arriving mid-hand is not somebody acting now
  var word = ACT_WORD[la.k];
  if (!word) {
    // a blind or an ante is nobody acting, but the chips still travel
    if ((la.k === 'sb' || la.k === 'bb' || la.k === 'post' || la.k === 'ante') && la.a > 0) {
      S.chips = (S.chips || []).filter(function (c) { return Date.now() - c.t0 < 1200; });
      S.chips.push({ n: la.n, id: la.id, amount: la.a, t0: Date.now() });
      clearTimeout(watchActs.c);
      watchActs.c = setTimeout(function () { S.chips = []; if (S.screen === 'table') render(); }, 1250);
    }
    return;
  }
  S.flash = { id: la.id, word: word, until: Date.now() + 1100 };
  if (la.k !== 'check') sfx('chip');
  // chips leaving the player and landing on the pot
  if (la.a > 0) {
    S.chips = (S.chips || []).filter(function (c) { return Date.now() - c.t0 < 1200; });
    S.chips.push({ n: la.n, id: la.id, amount: la.a, t0: Date.now() });
    clearTimeout(watchActs.c);
    watchActs.c = setTimeout(function () { S.chips = []; if (S.screen === 'table') render(); }, 1250);
  }
  clearTimeout(watchActs.t);
  watchActs.t = setTimeout(function () { S.flash = null; if (S.screen === 'table') render(); }, 1150);
}

// ---- the turn clock ----
// The ring round the player's circle empties over the seconds he has, and the last ten are
// counted out in figures as well. It is painted straight onto the element rather than through
// render(), because render() rebuilds the table and would throw away scroll and half-typed
// amounts twenty times a second. The server sends its own clock with every view, so a phone
// whose time is a minute out still draws the right amount left.
function paintTurn() {
  var v = S.v, h = v && v.hand;
  if (S.screen !== 'table' || !h || h.finished || !h.turnId || !h.deadline) return;
  var el = document.getElementById('tb' + h.turnId);
  if (!el) return;
  var total = ((v.settings && v.settings.turnSeconds) || 40) * 1000;
  var left = h.deadline - (Date.now() - (S.skew || 0));
  var frac = Math.max(0, Math.min(1, left / total));
  el.style.setProperty('--left', frac.toFixed(3));
  // The warning is in seconds, not in a share of the clock: a quarter of a forty-second turn is
  // ten seconds but a quarter of a twenty-second one is five, and five seconds of warning is not
  // the same thing at all. Ten seconds, or a third of the turn on a short clock, whichever is less.
  var warnAt = Math.min(10000, total / 3);
  var hot = left <= warnAt;
  if (hot) el.classList.add('hot'); else el.classList.remove('hot');
  var num = document.getElementById('ts' + h.turnId);
  if (num) {
    var secs = Math.max(0, Math.ceil(left / 1000));
    if (hot) { num.textContent = secs; num.style.display = 'flex'; }
    else num.style.display = 'none';
  }
}
setInterval(paintTurn, 200);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
if (S.token) { connect(); refresh().catch(function () { S.token = ''; try { localStorage.removeItem('sb-token'); } catch (e) {} render(); }); }
else render();

// ---------------------------------------------------------------- replays
// A kept hand, played back a step at a time: who did what, and what the board was.
var STREETS = { preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River' };
var ACTS = { fold: 'folds', check: 'checks', call: 'calls', bet: 'bets', raise: 'raises to', allin: 'is all in for', post: 'posts', ante: 'antes' };

function replaySheet() {
  var r = S.replay, rounds = r.rounds || [];
  if (!rounds.length) return '<div class="sheet" style="z-index:50"><div class="disp" style="font-size:26px">No hands kept</div>'
    + '<div class="muted small" style="margin-top:8px;white-space:normal">The replays of this game have been cleared. Only the last ten games keep them; the account statement stays for good.</div>'
    + '<button class="btn ghost" style="margin-top:14px" onclick="S.replay=null;render()">Back</button></div>';

  var g = rounds[Math.min(r.i, rounds.length - 1)];
  var step = r.step === undefined ? (g.acts || []).length : r.step;
  var acts = (g.acts || []).slice(0, step);
  var street = acts.length ? acts[acts.length - 1].s : 'preflop';
  var upto = { preflop: 0, flop: 3, turn: 4, river: 5 }[street] || 0;

  var h = '<div class="sheet" style="z-index:50">';
  h += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">'
    + '<div><div class="disp" style="font-size:26px;line-height:1.1">Hand ' + g.no + '</div>'
    + '<div class="muted small">' + esc(VARIANT_NAME(g.variant)) + ' &middot; ' + fmt(g.pot) + ' in the pot'
    + (g.label ? ' &middot; <span class="gold">' + esc(g.label) + '</span>' : '') + '</div></div>'
    + '<button class="rolechip" onclick="S.replay=null;render()">Close</button></div>';

  // which of the kept hands
  h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">';
  rounds.forEach(function (x, i) {
    // a hand kept for what it was rather than what it won says so, so it is worth tapping
    h += '<button class="rolechip' + (i === r.i ? ' on' : '') + '" onclick="S.replay.i=' + i + ';S.replay.step=undefined;render()">'
      + (x.tier ? (x.tier > 1 ? '\u2605 ' : '\u2666 ') : '') + fmt(x.pot) + '</button>';
  });
  h += '</div>';

  // the board as it stood at this point
  h += '<div class="evc" style="margin-top:12px"><div class="muted small">' + (STREETS[street] || '') + '</div>'
    + '<div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap">'
    + (g.boards || []).map(function (b) {
      return b.slice(0, upto).map(function (c) { return cardHtml(c, 'md'); }).join('');
    }).join('<div style="width:10px"></div>') + '</div></div>';

  // everyone in the hand, with the cards they showed
  h += '<div class="h2">THE HAND</div>';
  (g.players || []).forEach(function (p) {
    var shown = g.reveal && g.reveal[p.id] ? (g.reveal[p.id].cards || []) : [];
    var won = g.won && g.won[p.id];
    h += '<div class="row" style="margin-top:6px"><div style="flex:1;min-width:0">'
      + '<div style="font-size:14px;font-weight:600">' + esc(p.name) + (won ? ' <span class="gold" style="font-size:11px">WON ' + fmt(won) + '</span>' : '') + '</div>'
      + '<div class="muted small">started with ' + fmt(p.start) + '</div></div>'
      + '<div style="display:flex;gap:3px">' + (shown.length ? shown.map(function (c) { return cardHtml(c, 'sm'); }).join('') : '<span class="muted small">did not show</span>') + '</div></div>';
  });

  // the betting, a step at a time
  h += '<div class="h2">WHAT HAPPENED</div><div class="muted small" style="line-height:1.8">';
  var name = {};
  (g.players || []).forEach(function (p) { name[p.id] = p.name; });
  var lastStreet = '';
  acts.forEach(function (a) {
    if (a.s !== lastStreet) { h += '<div class="gold" style="margin-top:6px">' + (STREETS[a.s] || a.s) + '</div>'; lastStreet = a.s; }
    h += esc(name[a.id] || '?') + ' ' + (ACTS[a.k] || a.k) + (a.a ? ' ' + fmt(a.a) : '') + '<br>';
  });
  h += '</div>';

  var total = (g.acts || []).length;
  h += '<div style="display:flex;gap:8px;margin-top:12px">'
    + '<button class="btn ghost" style="flex:1" onclick="replayStep(-1)">&#8592; Back</button>'
    + '<button class="btn ghost" style="flex:1" onclick="replayStep(1)">Next &#8594;</button></div>'
    + '<div class="muted small" style="margin-top:6px;text-align:center">' + acts.length + ' of ' + total + ' moves</div>';
  return h + '</div>';
}
function runItVote(v) {
  var r = v.hand.runit;
  var mine = v.me && r.votes[v.me.id];
  var iVote = !!(v.me && r.voters.indexOf(v.me.id) >= 0);
  var done = 0;
  r.voters.forEach(function (id) { if (r.votes[id]) done += 1; });

  var h = '<div class="evc" style="margin:0"><div class="row" style="align-items:flex-start">'
    + '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600">Run it how many times?</div>'
    + '<div class="muted small" style="white-space:normal">Everyone is all in. ' + done + ' of ' + r.voters.length
    + ' have said. No answer counts as once.</div></div></div>';
  if (!iVote) return h + '</div>';

  h += '<div style="display:flex;gap:8px;margin-top:10px">';
  for (var n = 1; n <= (r.max || 1); n++) {
    h += '<button class="act" style="flex:1;background:' + (mine === n ? '#3a3016' : '#1f3328') + (mine === n ? ';color:#f3e9cf' : '')
      + '" onclick="voteRunIt(' + n + ')">' + (n === 1 ? 'Once' : n === 2 ? 'Twice' : n + ' times') + '</button>';
  }
  return h + '</div></div>';
}
function voteRunIt(n) { api('runit', { code: S.code, runs: n }).catch(fail); }

function replayStep(d) {
  var r = S.replay, g = r.rounds[r.i], total = (g.acts || []).length;
  var step = r.step === undefined ? total : r.step;
  r.step = Math.max(0, Math.min(total, step + d));
  render();
}
function VARIANT_NAME(v) {
  var found = (S.variants || []).filter(function (x) { return x.id === v; })[0];
  return found ? found.name : (v === 'holdem' ? "Texas Hold'em" : v);
}
