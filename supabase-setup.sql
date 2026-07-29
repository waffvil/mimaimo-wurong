-- M+V notes board — run this once in YOUR Supabase project:
-- Dashboard → SQL Editor → New query → paste → Run.

-- 1) table (id, text, author, full style as JSON, board position, timestamp)
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  body text not null check (char_length(body) between 1 and 500),
  author text check (char_length(author) <= 40),
  style jsonb not null default '{}'::jsonb,  -- colour, paper, edge, fasten, pin, tape, ink, tilt, doodle, drawing strokes
  x real,                                    -- board position (% of width); null = auto-placed
  y real,                                    -- board position (% of height); null = auto-placed
  created_at timestamptz not null default now()
);
-- if the table already existed from an earlier version, add the new columns:
alter table public.notes add column if not exists style jsonb not null default '{}'::jsonb;
alter table public.notes add column if not exists x real;
alter table public.notes add column if not exists y real;

alter table public.notes enable row level security;

-- 2) policies — this is a private two-person board behind a passcode, so the publishable
--    key is allowed full read/add/move/edit/delete. (No public link exposes it.)
drop policy if exists "notes readable by everyone" on public.notes;
drop policy if exists "anyone can add a note" on public.notes;
drop policy if exists "notes read"   on public.notes;
drop policy if exists "notes insert" on public.notes;
drop policy if exists "notes update" on public.notes;
drop policy if exists "notes delete" on public.notes;
create policy "notes read"   on public.notes for select to anon, authenticated using (true);
create policy "notes insert" on public.notes for insert to anon, authenticated with check (char_length(body) between 1 and 500);
create policy "notes update" on public.notes for update to anon, authenticated using (true) with check (true);
create policy "notes delete" on public.notes for delete to anon, authenticated using (true);

create index if not exists notes_created_at_idx on public.notes (created_at desc);

-- 3) starter notes (only inserts them if the board is empty) — so it opens looking lovely.
--    Delete/move/replace them freely; they're real notes now.
insert into public.notes (body, author)
select * from (values
  ('you made me tea this morning without asking ♡', 'em yêu'),
  ('you''re the prettiest girl in every room',      'anh yêu'),
  ('let''s do the picnic again — same bad sandwiches','em yêu'),
  ('i love your sleepy morning voice',              'anh yêu'),
  ('9 months. still butterflies',                   'em yêu'),
  ('dance with me in the kitchen tonight?',         'anh yêu'),
  ('thank you for being my calm',                   'em yêu'),
  ('come home safe, i''ll be waiting',              'anh yêu'),
  ('you make ordinary days feel soft',              'em yêu'),
  ('saved you the last bit of cake ❀',              'anh yêu'),
  ('your laugh is my favourite sound',              'em yêu'),
  ('i''d pick you again, every time',               'anh yêu')
) as seed(body, author)
where not exists (select 1 from public.notes);
