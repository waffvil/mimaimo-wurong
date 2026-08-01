-- M+V push notifications ("she left you a note ♡") — the server side.
-- Already applied to the live project as migration `push_notifications_setup`; this file is the
-- readable record of it, and what to re-run if the project is ever rebuilt from scratch.
--
-- Shape of the whole thing:
--   phone taps "turn them on"  ->  row in public.push_subs (tagged em yêu / anh yêu)
--   someone pins a note        ->  after-insert trigger on public.notes
--                              ->  pg_net POST to the notify-note Edge Function (x-mv-hook secret)
--                              ->  Function signs with the VAPID private key from app_secrets and
--                                  pushes to every subscription belonging to the OTHER person.
--
-- The VAPID private key NEVER goes to the browser: the client only ever holds the public key.

create extension if not exists pg_net;

-- 1) Server-only secrets. RLS enabled with NO policies, plus the grants revoked, so the publishable
--    key sees nothing at all. Only the service role (the Edge Function) can read this.
create table if not exists public.app_secrets (
  key   text primary key,
  value text not null
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

-- Fill these in yourself (dashboard → SQL editor); real values are NOT in this repo:
--   insert into public.app_secrets (key, value) values
--     ('vapid_public',  '<base64url public key>'),
--     ('vapid_private', '<base64url private key>'),   -- from vapid.secret.json, git-ignored
--     ('vapid_subject', 'mailto:you@example.com'),
--     ('notify_hook_secret', '<random string, also sent by the trigger>'),
--     ('notify_fn_url', 'https://<project>.supabase.co/functions/v1/notify-note');

-- 2) One row per installed phone that said yes.
create table if not exists public.push_subs (
  endpoint   text primary key,          -- push service URL; unique per device+browser
  p256dh     text not null,             -- device public key  (base64url)
  auth       text not null,             -- device auth secret (base64url)
  who        text not null check (who in ('em yêu', 'anh yêu')),
  label      text,
  created_at timestamptz not null default now(),
  last_ok    timestamptz,
  last_error text
);
create index if not exists push_subs_who_idx on public.push_subs (who);
alter table public.push_subs enable row level security;

-- The app may register and unregister a device, but may NOT read the table — without a select policy,
-- nobody holding the publishable key can enumerate the endpoints. Note this also rules out a PostgREST
-- upsert (merge-duplicates has to read the conflicting row), which is why the client does DELETE + INSERT.
drop policy if exists "subs insert" on public.push_subs;
drop policy if exists "subs update" on public.push_subs;
drop policy if exists "subs delete" on public.push_subs;
create policy "subs insert" on public.push_subs for insert to anon, authenticated with check (true);
create policy "subs update" on public.push_subs for update to anon, authenticated using (true) with check (true);
create policy "subs delete" on public.push_subs for delete to anon, authenticated using (true);

-- 3) The hook. security definer so it can read app_secrets past RLS; and it swallows every failure,
--    because a push problem must never stop someone from pinning a note.
create or replace function public.notify_new_note()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, net
as $$
declare
  hook_secret text;
  fn_url text;
begin
  select value into hook_secret from public.app_secrets where key = 'notify_hook_secret';
  select value into fn_url      from public.app_secrets where key = 'notify_fn_url';
  if hook_secret is null or fn_url is null then
    return new;
  end if;

  perform net.http_post(
    url     := fn_url,
    body    := jsonb_build_object('id', new.id, 'author', new.author, 'body', new.body),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-mv-hook', hook_secret),
    timeout_milliseconds := 5000
  );
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists notes_notify_insert on public.notes;
create trigger notes_notify_insert
  after insert on public.notes
  for each row execute function public.notify_new_note();

-- Handy checks:
--   select who, label, created_at, last_ok, last_error from public.push_subs;      -- who's registered
--   select status_code, content, created from net._http_response order by created desc limit 5;  -- hook fired?
