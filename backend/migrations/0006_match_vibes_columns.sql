-- Migration 0006: Match-vibes columns and weight tables
-- Depends on: 0005_grants.sql

-- ============================================================================
-- books: ranking-signal columns
-- ----------------------------------------------------------------------------
-- saves_count / likes_count
--   Feed the BookTok-3 velocity component, so a rising book can outrank a
--   saturated one with the same vibe overlap. Always 0 until user-action
--   triggers populate them in a later migration.
--
-- first_seen_at
--   Anchor for the recency exp-decay component. Defaulting to now() means
--   every existing seed-corpus book gets the migration-apply timestamp; that
--   makes recency uniform at cold start, which is the expected behavior
--   until newer books start arriving.
--
-- series_id
--   Used by the diversity penalty re-rank to avoid stacking multiple books
--   from the same series in one result set. Nullable, populated later by
--   an enrichment pass.
-- ============================================================================
alter table public.books
  add column if not exists saves_count   int          not null default 0,
  add column if not exists likes_count   int          not null default 0,
  add column if not exists first_seen_at timestamptz  not null default now(),
  add column if not exists series_id     text         null;

-- Recency lookups always read newest-first, so index desc.
create index if not exists books_first_seen_at_idx
  on public.books (first_seen_at desc);

-- Partial index: most rows will have null series_id, no point indexing them.
create index if not exists books_series_id_idx
  on public.books (series_id)
  where series_id is not null;

-- ============================================================================
-- vibe_category_weights
-- ----------------------------------------------------------------------------
-- Tunable per-category Jaccard weights for the ranking function. Stored in a
-- table rather than hardcoded in SQL so weights can be re-tuned with a plain
-- UPDATE — no migration needed.
--
-- Only the four "vibe overlap" categories live here. pace, spice, and
-- content_warnings are handled by separate components in the algorithm:
--   - pace is its own match factor (preserved from the existing function)
--   - spice is a hard range filter
--   - content_warnings are exclusion filters
-- ============================================================================
create table if not exists public.vibe_category_weights (
  category   text         primary key,
  weight     numeric(4,2) not null check (weight >= 0),
  updated_at timestamptz  not null default now()
);

-- Seed initial weights matching the BookTok-3 spec.
insert into public.vibe_category_weights (category, weight) values
  ('trope',     1.50),
  ('theme',     1.20),
  ('mood',      1.00),
  ('aesthetic', 0.80)
on conflict (category) do nothing;

-- ============================================================================
-- RLS
-- ============================================================================
alter table public.vibe_category_weights enable row level security;

-- World-readable; writes go through service role (which bypasses RLS).
create policy vibe_category_weights_select_all
  on public.vibe_category_weights
  for select
  using (true);

-- ============================================================================
-- Notes
-- ----------------------------------------------------------------------------
-- - Phase 2 (migration 0007) rewrites match_books_to_vibes to read from these
--   columns and the vibe_category_weights table.
-- - saves_count and likes_count are populated by future user-action triggers;
--   they are always 0 immediately after this migration applies.
-- - first_seen_at for existing books is set to migration-apply time. Recency
--   is therefore uniform across the seed corpus until new books arrive — this
--   is the expected cold-start behavior, not a bug to backfill.
-- - vibe_category_weights is intentionally a flat key/value table. To re-tune,
--   run: update public.vibe_category_weights set weight = X where category = Y;
--   no schema migration required.
