-- Migration 0009: Drop ambiguous match_books_to_vibes overload
-- Depends on: 0008_match_books_to_vibes_v2.sql

-- ============================================================================
-- A second match_books_to_vibes function with a different signature was
-- present in the remote DB during Phase 2 smoke testing. It is not defined
-- in any migration in this repo (created out-of-band, likely via Studio SQL
-- editor during early iteration). 0008's DROP targeted the 11-param
-- signature defined in 0004 and correctly skipped this unrelated 8-param
-- function, leaving Postgres unable to resolve calls due to ambiguous
-- overload selection.
--
-- Verified zero callers across the repo (grep across mobile/, backend/,
-- and docs returned only migration and README references). Safe to drop.
--
-- Signature being dropped:
--   match_books_to_vibes(text[], text[], text[], text[], text, int, int, int)
--   returns TABLE(book_id, title, cover_url, match_score double precision, ...)
-- ============================================================================

drop function if exists public.match_books_to_vibes(
  text[], text[], text[], text[], text, integer, integer, integer
);
