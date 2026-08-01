// M+V — "she left you a note" push.
//
// Two callers:
//   · the after-insert trigger on public.notes (see the push_notifications_setup migration) — a real note
//   · the app's "send a test ping" button — {test:true, who}, fixed text, so one phone can be tested alone
// verify_jwt is OFF because a Postgres trigger has no user JWT to send; each caller proves itself with its
// own credential instead (x-mv-hook / x-mv-key), both checked below against public.app_secrets.
//
// No secrets in this file — everything sensitive is read from app_secrets with the service role.

import { sendPush, type Sub, type Vapid } from "./webpush.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = SB_URL + "/rest/v1/";
const svc = {
  apikey: SERVICE_KEY,
  Authorization: "Bearer " + SERVICE_KEY,
  "Content-Type": "application/json",
};

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(REST + path, { ...init, headers: { ...svc, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(path + " -> " + res.status + " " + (await res.text()));
  return res.status === 204 ? null : await res.json();
}

/** Constant-time-ish compare, so a wrong hook secret can't be probed byte by byte. */
function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The test ping is called straight from the browser, so it needs CORS — but only from where the app
 * actually lives. Anything else gets no allow-origin header and the browser drops the response.
 */
function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  let ok = false;
  try {
    const h = new URL(origin).hostname;
    ok = h === "waffvil.github.io" || h === "localhost" || h === "127.0.0.1";
  } catch { ok = false; }
  return ok
    ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "content-type, x-mv-key",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "3600",
    }
    : {};
}

Deno.serve(async (req) => {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response("POST only", { status: 405, headers: cors });

  const secrets: Record<string, string> = {};
  for (const row of await rest("app_secrets?select=key,value")) secrets[row.key] = row.value;

  const payloadIn = await req.json().catch(() => ({}));
  const isTest = payloadIn.test === true;

  // Two callers, two credentials. The note hook is the database, which holds the hook secret. The test
  // ping is the app itself, which holds only the publishable key — the same key that can already read
  // and write the notes table, so authenticating with it grants nothing new. The hook secret stays
  // server-side, and a test ping can only ever send the fixed text below.
  if (isTest) {
    const key = req.headers.get("x-mv-key") || "";
    if (!secrets.publishable_key || !sameSecret(key, secrets.publishable_key)) {
      return new Response("nope", { status: 401, headers: cors });
    }
  } else {
    const given = req.headers.get("x-mv-hook") || "";
    if (!secrets.notify_hook_secret || !sameSecret(given, secrets.notify_hook_secret)) {
      return new Response("nope", { status: 401, headers: cors });
    }
  }

  const author: string | null = payloadIn.author ?? null;
  const noteBody: string = String(payloadIn.body ?? "");

  // A real note notifies the OTHER person; a test ping goes to whoever asked for it. (No author on the
  // row shouldn't happen — tell both in that case, which is better than silence.)
  const target = isTest
    ? (payloadIn.who === "em yêu" || payloadIn.who === "anh yêu" ? payloadIn.who : null)
    : author === "em yêu" ? "anh yêu" : author === "anh yêu" ? "em yêu" : null;
  const q = "push_subs?select=endpoint,p256dh,auth,who" + (target ? "&who=eq." + encodeURIComponent(target) : "");
  const subs: (Sub & { who: string })[] = await rest(q);

  if (!subs.length) {
    return new Response(JSON.stringify({ sent: 0, note: "no subscriptions for " + (target ?? "anyone") }),
      { headers: { ...cors, "Content-Type": "application/json" } });
  }

  const vapid: Vapid = {
    publicKey: secrets.vapid_public,
    privateKey: secrets.vapid_private,
    subject: secrets.vapid_subject,
  };
  const notification = JSON.stringify(isTest
    ? {
      title: "test ping ♡",
      body: "if you can see this, notifications work",
      tag: "mv-test",
      url: "./",
    }
    : {
      title: (author ? author + " left you a note" : "a new note") + " ♡",
      body: noteBody.length > 140 ? noteBody.slice(0, 139) + "…" : noteBody,
      tag: "mv-note",         // collapses a burst of notes into one line rather than a stack
      url: "./",
    });

  const nowSec = Math.floor(Date.now() / 1000);
  const results = await Promise.all(subs.map(async (s) => {
    try {
      const { status, text } = await sendPush(s, notification, vapid, nowSec);
      if (status === 404 || status === 410) {
        // The push service says this subscription is permanently gone (app deleted, or it expired).
        await rest("push_subs?endpoint=eq." + encodeURIComponent(s.endpoint), { method: "DELETE" });
        return { who: s.who, status, action: "deleted dead subscription" };
      }
      await rest("push_subs?endpoint=eq." + encodeURIComponent(s.endpoint), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(status < 300
          ? { last_ok: new Date().toISOString(), last_error: null }
          : { last_error: status + " " + text.slice(0, 200) }),
      });
      return { who: s.who, status, action: status < 300 ? "sent" : "push service refused" };
    } catch (e) {
      return { who: s.who, status: 0, action: "error: " + (e as Error).message };
    }
  }));

  console.log("notify-note", JSON.stringify({ test: isTest, author, target, results }));
  return new Response(JSON.stringify({ sent: results.filter((r) => r.status < 300 && r.status > 0).length, results }),
    { headers: { ...cors, "Content-Type": "application/json" } });
});
