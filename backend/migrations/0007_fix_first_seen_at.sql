-- Migration 0007: Fix books.first_seen_at type and nullability
-- Depends on: 0006_match_vibes_columns.sql

-- ============================================================================
-- books.first_seen_at: type and nullability fix
-- ----------------------------------------------------------------------------
-- The first_seen_at column existed on the books table prior to migration 0006
-- with the wrong type (timestamp without time zone) and wrong nullability
-- (nullable). 0006 used `add column if not exists` which silently kept the
-- pre-existing definition. This migration corrects both.
--
-- Existing values (1121 rows across 6 distinct insertion-time timestamps,
-- spanning 2026-03-31 to 2026-04-30) are preserved by interpreting them as
-- UTC. This retains the weak-but-real recency signal of when books entered
-- the catalog rather than discarding it for a uniform cold-start.
-- ============================================================================

alter table public.books
  alter column first_seen_at type timestamptz using first_seen_at at time zone 'UTC',
  alter column first_seen_at set not null;
