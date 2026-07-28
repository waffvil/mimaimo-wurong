-- M+V notes board — run this once in your Supabase project:
-- Dashboard → SQL Editor → New query → paste → Run.

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  body text not null check (char_length(body) between 1 and 500),
  author text check (char_length(author) <= 40),
  color text check (char_length(color) <= 20),
  created_at timestamptz not null default now()
);

alter table public.notes enable row level security;

-- everyone can read the whole board
drop policy if exists "notes readable by everyone" on public.notes;
create policy "notes readable by everyone"
  on public.notes for select
  to anon, authenticated
  using (true);

-- everyone can pin a new note (size-limited by the column check)
drop policy if exists "anyone can add a note" on public.notes;
create policy "anyone can add a note"
  on public.notes for insert
  to anon, authenticated
  with check (char_length(body) between 1 and 500);

-- (no update/delete policies → notes can never be edited or wiped by the public key)

create index if not exists notes_created_at_idx on public.notes (created_at desc);
