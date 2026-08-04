-- M+V letters — long-form letters the two of them write to each other.
-- Already applied to the live project as migration `letters_table`; this is the readable record.
--
-- Separate from notes on purpose: a note is a scrap pinned to a board, a letter is a letter — no length
-- limit, and it arrives SEALED and stays sealed until the person it was written for opens it.
create table if not exists public.letters (
  id         uuid primary key default gen_random_uuid(),
  body       text not null check (char_length(body) between 1 and 20000),
  author     text not null check (author in ('em yêu', 'anh yêu')),
  title      text check (char_length(title) <= 120),
  -- author is whose name is ON the letter (the writer chooses it); sent_by is which phone it came from,
  -- and that is what decides whether a letter is sealed "for you"
  sent_by    text check (sent_by is null or sent_by in ('em yêu', 'anh yêu')),
  created_at timestamptz not null default now(),
  opened_at  timestamptz                       -- null = still sealed
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
