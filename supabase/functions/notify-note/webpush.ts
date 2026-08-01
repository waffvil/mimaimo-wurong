// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) on nothing but WebCrypto and fetch.
//
// Why hand-rolled instead of npm:web-push — that library talks through node's `https` module, which
// is the shakiest corner of Deno's node compat, and a failure would only ever show up as a silent
// non-delivery on a phone I can't debug. This has no dependencies, runs identically in Deno and in
// node 22 (same WebCrypto), and so can be round-trip tested on a laptop before it ever ships.
//
// Byte layout of the body we POST (RFC 8188 §2.1, as narrowed by RFC 8291 §4):
//   salt(16) | record-size(4, BE) | key-id-length(1) = 65 | ephemeral-public-key(65) | ciphertext
// The plaintext is the payload with a single 0x02 delimiter appended (last-record marker).

export function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info } as any, key, len * 8);
  return new Uint8Array(bits);
}

export type Sub = { endpoint: string; p256dh: string; auth: string };
export type Vapid = { publicKey: string; privateKey: string; subject: string };

/** Encrypt `payload` for one subscription. `test` lets the round-trip test pin the random parts. */
export async function encryptPayload(
  payload: string,
  p256dh: string,
  authSecret: string,
  test?: { salt?: Uint8Array; keys?: CryptoKeyPair }
): Promise<Uint8Array> {
  const uaPublic = b64uToBytes(p256dh);
  const uaAuth = b64uToBytes(authSecret);

  const uaKey = await crypto.subtle.importKey("raw", uaPublic as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const kp = test?.keys ?? (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as any, kp.privateKey, 256));

  // RFC 8291 §3.3 — the auth secret is the HKDF *salt* here, and the context binds both public keys.
  const ikm = await hkdf(uaAuth, shared, concat(utf8("WebPush: info\0"), uaPublic, asPublic), 32);

  const salt = test?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  const plaintext = concat(utf8(payload), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, plaintext as BufferSource));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/** The `Authorization: vapid t=<jwt>, k=<pub>` header proving we own the application server key. */
export async function vapidAuth(endpoint: string, vapid: Vapid, nowSec: number): Promise<string> {
  const pub = b64uToBytes(vapid.publicKey);
  const jwk = {
    kty: "EC", crv: "P-256",
    x: bytesToB64u(pub.slice(1, 33)),
    y: bytesToB64u(pub.slice(33, 65)),
    d: vapid.privateKey,          // already base64url, which is what JWK wants
    ext: true,
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

  const header = bytesToB64u(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64u(utf8(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: nowSec + 12 * 3600,          // spec caps this at 24h; 12 is the usual safe choice
    sub: vapid.subject,
  })));
  const signed = header + "." + claims;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signed) as BufferSource));
  return "vapid t=" + signed + "." + bytesToB64u(sig) + ", k=" + vapid.publicKey;
}

/**
 * Deliver one notification. Resolves with the push service's status — the caller decides what to do
 * with it; 404/410 mean the subscription is dead and should be deleted.
 */
export async function sendPush(sub: Sub, payload: string, vapid: Vapid, nowSec: number, ttl = 24 * 3600) {
  const body = await encryptPayload(payload, sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(sub.endpoint, vapid, nowSec),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "normal",
    },
    body,
  });
  return { status: res.status, text: res.ok ? "" : await res.text().catch(() => "") };
}
