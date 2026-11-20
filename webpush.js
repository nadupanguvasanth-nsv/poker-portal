'use strict';
// Web Push without dependencies: VAPID signing (RFC 8292) and message encryption (RFC 8291, aes128gcm).
const crypto = require('crypto');

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

function makeVapid() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  return { publicKey: b64u(pub), privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
}

function vapidHeader(endpoint, vapid, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: Buffer.from(vapid.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}

const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

// encrypt one message for a subscription ({keys: {p256dh, auth}}). `opts` lets tests fix the random values.
function encrypt(sub, payload, opts = {}) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const salt = opts.salt || crypto.randomBytes(16);
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPub);
  const prk = hkdf(auth, secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const cek = hkdf(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const data = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // one record, last-record delimiter
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const enc = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, enc]);
}

// the receiving side (used by tests, and handy for checking)
function decrypt(uaPrivate, uaPub, auth, body) {
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), enc = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPub);
  const prk = hkdf(auth, secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const cek = hkdf(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(enc.subarray(enc.length - 16));
  const plain = Buffer.concat([d.update(enc.subarray(0, enc.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString();
}

// returns {ok, gone}; gone means the subscription is dead and should be dropped
async function send(sub, payload, vapid, subject, opts = {}) {
  const body = encrypt(sub, JSON.stringify(payload));
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(sub.endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttl || 120), Urgency: opts.urgency || 'high',
    },
    body,
  });
  return { ok: r.ok, gone: r.status === 404 || r.status === 410, status: r.status };
}

module.exports = { makeVapid, vapidHeader, encrypt, decrypt, send, b64u, unb64u };
