// Build the published, ENCRYPTED index.html from the plaintext dev source.
//
//   node build.js              # passcode taken from index.src.html (the source of truth)
//   MV_CODE=123456 node build.js   # or override it explicitly
//
// It reads index.src.html (git-ignored — contains the letter, passcode, and
// Supabase key in the clear) and writes index.html (safe to publish):
//   • the letter + notes board + Supabase creds are AES-256-GCM encrypted,
//     unlockable only by the passcode (PBKDF2-SHA256 derived key);
//   • the passcode itself is NOT stored anywhere;
//   • dev-only bits (debug bar, ?preview bypasses) are stripped.
//
// NOTE: this file carries NO secret — it is safe to commit to a public repo. The passcode
// lives only in index.src.html (git-ignored), and is read from there at build time.

const fs = require("fs");
const crypto = require("crypto");

const ITER = 310000; // PBKDF2 iterations (slows brute-force of the 6-digit code)

let src = fs.readFileSync("index.src.html", "utf8");

// passcode: prefer an explicit override, else read it straight from the dev source
const codeMatch = src.match(/var CORRECT_CODE = "([^"]*)";/);
const PASSCODE = process.env.MV_CODE || (codeMatch && codeMatch[1]);
if (!PASSCODE) throw new Error("No passcode found — set MV_CODE or a CORRECT_CODE in index.src.html");

// 1 — pull out the sensitive bits
const siteRe = /(<main class="site" id="site">)([\s\S]*?)(<\/main>)/;
const siteMatch = src.match(siteRe);
if (!siteMatch) throw new Error('Could not find <main class="site" id="site"> … </main>');
const siteInner = siteMatch[2];

const urlMatch = src.match(/var SUPABASE_URL = "([^"]*)";/);
const keyMatch = src.match(/var SUPABASE_KEY = "([^"]*)";/);
if (!urlMatch || !keyMatch) throw new Error("Could not find Supabase creds");

// 2 — encrypt { site, url, key } with a key derived from the passcode
const payload = JSON.stringify({ site: siteInner, url: urlMatch[1], key: keyMatch[1] });
const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(Buffer.from(PASSCODE, "utf8"), salt, ITER, 32, "sha256");
const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
const ct = Buffer.concat([cipher.update(Buffer.from(payload, "utf8")), cipher.final()]);
const ctTag = Buffer.concat([ct, cipher.getAuthTag()]); // browser SubtleCrypto expects ciphertext||tag
const enc = {
  salt: salt.toString("base64"),
  iv: iv.toString("base64"),
  ct: ctTag.toString("base64"),
  iter: ITER,
};

// 3 — produce the published HTML
let out = src
  .replace(siteRe, "$1$3")                                   // empty the #site (content is encrypted)
  .replace(/var SUPABASE_URL = "[^"]*";/, 'var SUPABASE_URL = "";')
  .replace(/var SUPABASE_KEY = "[^"]*";/, 'var SUPABASE_KEY = "";')
  .replace(/var CORRECT_CODE = "[^"]*";/, "var CORRECT_CODE = null;") // no plaintext code shipped
  .replace(/<!--DEV_ONLY_START-->[\s\S]*?<!--DEV_ONLY_END-->/g, "")   // strip debug bar
  .replace(/\/\*DEV_ONLY_START\*\/[\s\S]*?\/\*DEV_ONLY_END\*\//g, "") // strip ?preview bypasses
  .replace(/<!--ENC_PAYLOAD-->/, "<script>window.ENC_PAYLOAD = " + JSON.stringify(enc) + ";</script>");

if (out.indexOf(PASSCODE) !== -1) throw new Error("Refusing to write: passcode still present in output!");
if (out.indexOf(urlMatch[1]) !== -1) throw new Error("Refusing to write: Supabase URL still present in output!");
if (keyMatch[1] && out.indexOf(keyMatch[1]) !== -1) throw new Error("Refusing to write: Supabase key still present in output!");

fs.writeFileSync("index.html", out);
console.log("✓ Built index.html (encrypted). ciphertext bytes:", ctTag.length, "| PBKDF2 iters:", ITER);
