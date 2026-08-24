-- M+V keep-awake — the readable record of migration `keepalive_table`.
--
-- Why this table exists at all: Supabase pauses a Free project that doesn't see "a few user requests to the
-- database each day" over a 7-day window (docs: platform/free-project-pausing). It counts REQUESTS PER DAY,
-- not bytes — so a single big write, or a junk row written and deleted once every few days, does nothing.
-- The keepalive workflow (.github/workflows/keepalive.yml) makes six requests three times a day instead.
--
-- Why the job writes HERE and not a letter:
--   · public.letters has an after-insert trigger that pushes a notification to the other phone. A keepalive
--     letter would ping her three times a day, forever, including at 06:17 UTC.
--   · anything written into notes or letters would also appear on the board, in the letters inbox, and in
--     the tidying list in the settings.
-- This table has no trigger and no screen, and the app never reads it.
create table if not exists public.keepalive (
  id  bigserial primary key,
  at  timestamptz not null default now(),
  who text
);
create index if not exists keepalive_at_idx on public.keepalive (at desc);

alter table public.keepalive enable row level security;

drop policy if exists "keepalive read"   on public.keepalive;
drop policy if exists "keepalive insert" on public.keepalive;
drop policy if exists "keepalive delete" on public.keepalive;
create policy "keepalive read"   on public.keepalive for select to anon, authenticated using (true);
create policy "keepalive insert" on public.keepalive for insert to anon, authenticated with check (true);
create policy "keepalive delete" on public.keepalive for delete to anon, authenticated using (true);

-- The workflow prunes anything older than 3 days on every run, so this never grows:
--   delete from public.keepalive where at < now() - interval '3 days';
