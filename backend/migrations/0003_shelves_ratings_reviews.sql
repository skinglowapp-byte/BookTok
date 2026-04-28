-- Migration 0003: Shelves, ratings, reviews, reading activity
-- Depends on: 0001_core_tables.sql, 0002_vibes.sql

-- ============================================================================
-- shelves
-- Both system shelves (Want to Read, Reading, Read, DNF, Owned) and custom user shelves.
-- System shelves are auto-created via trigger when profile is created.
-- ============================================================================
create table public.shelves (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  slug text not null,                              -- url-safe; system shelves use fixed slugs
  is_system boolean default false,                 -- true for the 5 default shelves
  is_private boolean default false,
  display_order int default 0,
  cover_image_url text,                            -- optional custom shelf cover for share cards
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, slug)
);

create index shelves_user_idx on public.shelves (user_id, display_order);

-- System shelf creation trigger
create or replace function public.create_default_shelves()
returns trigger as $$
begin
  insert into public.shelves (user_id, name, slug, is_system, display_order) values
    (new.id, 'Want to Read', 'want_to_read', true, 0),
    (new.id, 'Reading', 'reading', true, 1),
    (new.id, 'Read', 'read', true, 2),
    (new.id, 'DNF', 'dnf', true, 3),
    (new.id, 'Owned', 'owned', true, 4);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_profile_created
  after insert on public.profiles
  for each row execute function public.create_default_shelves();

-- ============================================================================
-- shelf_items
-- A book on a shelf. Same book can be on multiple shelves (e.g. Reading + Owned).
-- ============================================================================
create table public.shelf_items (
  id uuid primary key default uuid_generate_v4(),
  shelf_id uuid not null references public.shelves(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  added_at timestamptz default now(),
  user_tags text[] default '{}',                   -- free-form user tags
  notes text,
  unique (shelf_id, book_id)
);

create index shelf_items_user_idx on public.shelf_items (user_id, added_at desc);
create index shelf_items_shelf_idx on public.shelf_items (shelf_id, added_at desc);
create index shelf_items_book_idx on public.shelf_items (book_id);

-- ============================================================================
-- reading_progress
-- Tracks current page/percentage and reading sessions per (user, book).
-- One row per (user, book) — updated as they read.
-- ============================================================================
create table public.reading_progress (
  user_id uuid not null references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  current_page int default 0,
  total_pages int,
  percent numeric(5,2) default 0,                  -- 0-100
  format text default 'physical',                  -- 'physical' | 'ebook' | 'audiobook'
  started_at timestamptz,
  last_updated_at timestamptz default now(),
  finished_at timestamptz,
  primary key (user_id, book_id)
);

create index reading_progress_user_active_idx on public.reading_progress (user_id, last_updated_at desc)
  where finished_at is null;

-- ============================================================================
-- ratings
-- Quarter-star granularity: stored as int 1-20 (1=0.25 stars, 20=5 stars).
-- ============================================================================
create table public.ratings (
  user_id uuid not null references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  rating int not null check (rating between 1 and 20),
  rated_at timestamptz default now(),
  primary key (user_id, book_id)
);

create index ratings_book_idx on public.ratings (book_id);
create index ratings_user_idx on public.ratings (user_id, rated_at desc);

-- Helper view: stars as decimal
create view public.ratings_decimal as
  select user_id, book_id, (rating::numeric / 4) as stars, rated_at
  from public.ratings;

-- ============================================================================
-- reviews
-- Optional written review attached to a rating.
-- ============================================================================
create table public.reviews (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  body text not null,
  has_spoilers boolean default false,
  user_assigned_vibes text[] default '{}',         -- user's own vibe tags for this book
  user_assigned_warnings jsonb default '[]'::jsonb,
  is_public boolean default true,
  like_count int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, book_id)
);

create index reviews_book_idx on public.reviews (book_id, like_count desc);
create index reviews_user_idx on public.reviews (user_id, created_at desc);

-- ============================================================================
-- reading_sessions
-- Optional granular session tracking for Bookly-style stats.
-- Not required for MVP 1 but schema is here so we don't migrate later.
-- ============================================================================
create table public.reading_sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  pages_read int,
  duration_seconds int,
  notes text,
  created_at timestamptz default now()
);

create index reading_sessions_user_idx on public.reading_sessions (user_id, started_at desc);

-- ============================================================================
-- RLS
-- ============================================================================
alter table public.shelves enable row level security;
alter table public.shelf_items enable row level security;
alter table public.reading_progress enable row level security;
alter table public.ratings enable row level security;
alter table public.reviews enable row level security;
alter table public.reading_sessions enable row level security;

create policy shelves_owner on public.shelves
  for all using (auth.uid() = user_id);

create policy shelves_public_read on public.shelves
  for select using (is_private = false);

create policy shelf_items_owner on public.shelf_items
  for all using (auth.uid() = user_id);

create policy shelf_items_public_read on public.shelf_items
  for select using (
    exists (
      select 1 from public.shelves s
      where s.id = shelf_items.shelf_id and s.is_private = false
    )
  );

create policy reading_progress_owner on public.reading_progress
  for all using (auth.uid() = user_id);

create policy ratings_owner on public.ratings
  for all using (auth.uid() = user_id);

create policy ratings_public_read on public.ratings
  for select using (true);

create policy reviews_owner on public.reviews
  for all using (auth.uid() = user_id);

create policy reviews_public_read on public.reviews
  for select using (is_public = true);

create policy reading_sessions_owner on public.reading_sessions
  for all using (auth.uid() = user_id);
