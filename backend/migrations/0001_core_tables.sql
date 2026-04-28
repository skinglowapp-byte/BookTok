-- Migration 0001: Extensions, core book and user tables
-- Run order: first migration after fresh Supabase project init

-- Extensions
create extension if not exists "pgcrypto";
create extension if not exists "vector";

-- ============================================================================
-- profiles
-- Extends auth.users with app-specific user data.
-- One row per user, created via trigger after auth.users insert.
-- ============================================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text unique not null,
  display_name text,
  bio text,
  avatar_url text,
  reader_types text[] default '{}',                -- e.g. ['romance', 'fantasy']
  aesthetic_theme text default 'minimalist_cream',  -- onboarding pick
  reading_goal_yearly int,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index profiles_handle_idx on public.profiles (handle);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, handle)
  values (
    new.id,
    -- generate temporary handle from email; user updates in onboarding
    'user_' || substring(new.id::text from 1 for 8)
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- authors
-- Normalized author records. Books link via books.author_ids array.
-- ============================================================================
create table public.authors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  open_library_id text unique,        -- e.g. 'OL12345A'
  bio text,
  photo_url text,
  created_at timestamptz default now()
);

create index authors_name_idx on public.authors using gin (to_tsvector('english', name));
create index authors_ol_idx on public.authors (open_library_id);

-- ============================================================================
-- books
-- Core book records sourced from Open Library and user-added editions.
-- ============================================================================
create table public.books (
  id uuid primary key default gen_random_uuid(),
  open_library_id text unique,        -- e.g. 'OL12345W' (work) or 'OL12345M' (edition)
  isbn_13 text,
  isbn_10 text,
  title text not null,
  subtitle text,
  author_ids uuid[] default '{}',     -- references authors.id
  description text,
  cover_url text,
  page_count int,
  published_year int,
  language text default 'en',
  format text default 'unknown',      -- 'physical' | 'ebook' | 'audiobook' | 'unknown'
  publisher text,
  genre_tags text[] default '{}',     -- raw genre tags from source, pre-vibe-extraction
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index books_title_idx on public.books using gin (to_tsvector('english', title));
create index books_isbn13_idx on public.books (isbn_13);
create index books_isbn10_idx on public.books (isbn_10);
create index books_ol_idx on public.books (open_library_id);
create index books_author_ids_idx on public.books using gin (author_ids);

-- Trigram index for fuzzy search (typo tolerance)
create extension if not exists pg_trgm;
create index books_title_trgm_idx on public.books using gin (title gin_trgm_ops);
create index authors_name_trgm_idx on public.authors using gin (name gin_trgm_ops);

-- ============================================================================
-- RLS
-- ============================================================================
alter table public.profiles enable row level security;
alter table public.authors enable row level security;
alter table public.books enable row level security;

-- Profiles: anyone can read public profiles, only the owner can update
create policy profiles_select_all on public.profiles
  for select using (true);

create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id);

-- Authors and books: world-readable, write via service role only (backend ingestion)
create policy authors_select_all on public.authors
  for select using (true);

create policy books_select_all on public.books
  for select using (true);
