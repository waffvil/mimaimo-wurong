-- M+V letters — long-form letters the two of them write to each other.
-- Already applied to the live project as migration `letters_table`; this is the readable record.
--
-- Separate from notes on purpose: a note is a scrap pinned to a board, a letter is a letter — no length
-- limit, and it arrives SEALED and stays sealed until the person it was written for opens it.
create table if not exists public.letters (
  id         uuid primary key default gen_random_uuid(),
  body       text not null check (char_length(body) between 1 and 20000),
  -- how the writer signed it: free text, their choice (a name, a nickname, anything)
  author     text not null check (char_length(author) between 1 and 40),
  title      text check (char_length(title) <= 120),
  -- author is whose name is ON the letter (the writer chooses it); sent_by is which phone it came from,
  -- and that is what decides whether a letter is sealed "for you"
  sent_by    text check (sent_by is null or sent_by in ('em yêu', 'anh yêu')),
  created_at timestamptz not null default now(),
  opened_at  timestamptz,                      -- null = still sealed
  -- How the writer dressed it: paper tint, tape colour, sticker — a tiny JSON blob of INDICES written by the
  -- client ({"p":1,"t":2,"s":3}), null when everything is the default. Indices rather than colours, so
  -- restyling the app restyles every letter already sent instead of leaving old ones in dead hex codes.
  -- (Applied live as migration `letters_style_column`.)
  style      text check (style is null or char_length(style) <= 200)
);
create index if not exists letters_created_at_idx on public.letters (created_at desc);

alter table public.letters enable row level security;

-- Same trust model as the notes board: a private two-person app behind a passcode, and the publishable key
-- never leaves the encrypted build, so it may read and write freely.
drop policy if exists "letters read"   on public.letters;
drop policy if exists "letters insert" on public.letters;
drop policy if exists "letters update" on public.letters;
drop policy if exists "letters delete" on public.letters;
create policy "letters read"   on public.letters for select to anon, authenticated using (true);
create policy "letters insert" on public.letters for insert to anon, authenticated with check (char_length(body) >= 1);
create policy "letters update" on public.letters for update to anon, authenticated using (true) with check (true);
create policy "letters delete" on public.letters for delete to anon, authenticated using (true);

-- ---------------------------------------------------------------------------------------------------
-- A letter announces itself, the same way a note does. Applied live as migration `letters_notify`.
-- Chain: letter inserted -> this trigger -> pg_net POST to notify-note (x-mv-hook) -> push to the OTHER
-- phone. See supabase-push-setup.sql for the tables and secrets it leans on.
--
-- Two deliberate differences from the note hook:
--   · it sends sent_by (the phone it came from), because `author` on a letter is a free-text signature the
--     writer chose and can be anything at all — it must never decide who the letter is for;
--   · it sends the TITLE and never the body. A letter is long and private, and opening it is half the gift.
create or replace function public.notify_new_letter()
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
    body    := jsonb_build_object('kind', 'letter', 'id', new.id, 'author', new.author,
                                  'title', new.title, 'sent_by', new.sent_by),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-mv-hook', hook_secret),
    timeout_milliseconds := 5000
  );
  return new;
-- a push problem must never stop a letter from being sent
exception when others then
  return new;
end;
$$;

drop trigger if exists letters_notify_insert on public.letters;
create trigger letters_notify_insert
  after insert on public.letters
  for each row execute function public.notify_new_letter();
