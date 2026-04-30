-- Migration 0008: Rewrite match_books_to_vibes for BookTok-3 ranking
-- Depends on: 0007_fix_first_seen_at.sql

-- ============================================================================
-- Drop the previous function (0004 definition, no consumers in repo as of 0007)
-- ============================================================================
drop function if exists public.match_books_to_vibes(
  uuid, text[], text[], text[], text[], text, int, int, uuid[], uuid, int
);

-- ============================================================================
-- match_books_to_vibes (BookTok-3)
-- ----------------------------------------------------------------------------
-- Core ranking function. Returns the top p_limit books matching the given
-- vibe filters, scored as:
--
--   live mode:        0.50 * jaccard + 0.20 * velocity + 0.15 * recency
--   cold-start mode:  0.70 * jaccard                    + 0.15 * recency
--
-- minus a diversity penalty (max 0.15) that demotes repeats from the same
-- author or series in a single result set.
--
-- See the closing "Notes" block for tuning knobs and deferred features.
-- ============================================================================
create or replace function public.match_books_to_vibes(
  p_user_id        uuid    default null,
  p_moods          text[]  default '{}',
  p_tropes         text[]  default '{}',
  p_aesthetics     text[]  default '{}',
  p_themes         text[]  default '{}',
  p_pace           text    default null,
  p_spice_min      int     default 0,
  p_spice_max      int     default 5,
  p_avoid_book_ids uuid[]  default '{}',
  p_avoid_cw_tags  text[]  default '{}',
  p_limit          int     default 3
)
returns table (
  book_id              uuid,
  final_score          numeric,
  jaccard_score        numeric,
  velocity_score       numeric,
  recency_score        numeric,
  diversity_penalty    numeric,
  matched_vibes        text[],
  cold_start_mode      boolean
)
language sql
stable
as $$
  with weights as (
    select
      coalesce((select weight from public.vibe_category_weights where category = 'mood'),      1.0) as w_mood,
      coalesce((select weight from public.vibe_category_weights where category = 'trope'),     1.5) as w_trope,
      coalesce((select weight from public.vibe_category_weights where category = 'aesthetic'), 0.8) as w_aesthetic,
      coalesce((select weight from public.vibe_category_weights where category = 'theme'),     1.2) as w_theme
  ),
  mode as (
    select (sum(saves_count + likes_count) < 100) as is_cold_start
    from public.books
  ),
  eligible as (
    -- author_ids[1] aliased as author_id: books.author_ids is uuid[]; the
    -- diversity penalty partitions on the primary (first-listed) author.
    select b.id,
           b.author_ids[1] as author_id,
           b.series_id, b.first_seen_at,
           b.saves_count, b.likes_count,
           bv.moods, bv.tropes, bv.aesthetics, bv.themes,
           bv.pace, bv.spice_level, bv.content_warnings
    from public.books b
    join public.book_vibes bv on bv.book_id = b.id
    where bv.confidence >= 0.4
      and bv.spice_level between p_spice_min and p_spice_max
      and not (b.id = any(p_avoid_book_ids))
      and not exists (
        select 1
        from jsonb_array_elements(bv.content_warnings) as cw
        where cw->>'tag' = any(p_avoid_cw_tags)
          and cw->>'severity' = 'graphic'
      )
  ),
  jaccard as (
    select e.id as book_id,
           e.author_id, e.series_id, e.first_seen_at,
           e.saves_count, e.likes_count, e.pace,
           -- Weighted overlap numerator
           (
             w.w_mood      * cardinality(array(select unnest(p_moods)      intersect select unnest(e.moods))) +
             w.w_trope     * cardinality(array(select unnest(p_tropes)     intersect select unnest(e.tropes))) +
             w.w_aesthetic * cardinality(array(select unnest(p_aesthetics) intersect select unnest(e.aesthetics))) +
             w.w_theme     * cardinality(array(select unnest(p_themes)     intersect select unnest(e.themes)))
           )::numeric as weighted_intersection,
           -- Weighted union denominator
           (
             w.w_mood      * cardinality(array(select unnest(p_moods)      union select unnest(e.moods))) +
             w.w_trope     * cardinality(array(select unnest(p_tropes)     union select unnest(e.tropes))) +
             w.w_aesthetic * cardinality(array(select unnest(p_aesthetics) union select unnest(e.aesthetics))) +
             w.w_theme     * cardinality(array(select unnest(p_themes)     union select unnest(e.themes)))
           )::numeric as weighted_union,
           -- Matched vibes (for the response, no weighting needed)
           (
             array(select unnest(p_moods)      intersect select unnest(e.moods)) ||
             array(select unnest(p_tropes)     intersect select unnest(e.tropes)) ||
             array(select unnest(p_aesthetics) intersect select unnest(e.aesthetics)) ||
             array(select unnest(p_themes)     intersect select unnest(e.themes))
           ) as matched_vibes
    from eligible e cross join weights w
  ),
  velocity_raw as (
    select book_id, author_id, series_id, first_seen_at, pace, matched_vibes,
           weighted_intersection, weighted_union,
           (saves_count + likes_count)::numeric /
             greatest(extract(day from now() - first_seen_at)::numeric, 1.0) as raw_v
    from jaccard
  ),
  velocity_normalized as (
    select *,
           case
             when (max(raw_v) over () - min(raw_v) over ()) = 0 then 0::numeric
             else (raw_v - min(raw_v) over ()) / (max(raw_v) over () - min(raw_v) over ())
           end as velocity_score
    from velocity_raw
  ),
  scored as (
    select v.book_id, v.author_id, v.series_id, v.matched_vibes,
           -- Jaccard score (0-1)
           case when v.weighted_union = 0 then 0::numeric
                else v.weighted_intersection / v.weighted_union end as jaccard_score,
           v.velocity_score,
           -- Recency: exp decay, ~30-day half-life (ln(2)/0.023 ≈ 30.1)
           exp(-0.023 * extract(day from now() - v.first_seen_at)::numeric)::numeric as recency_score,
           m.is_cold_start
    from velocity_normalized v cross join mode m
  ),
  base_scored as (
    select s.*,
           -- Mode-aware base score (before diversity penalty)
           case when s.is_cold_start then
             (0.70 * s.jaccard_score) + (0.15 * s.recency_score)
           else
             (0.50 * s.jaccard_score) + (0.20 * s.velocity_score) + (0.15 * s.recency_score)
           end as base_score
    from scored s
  ),
  diversified as (
    -- coalesce(series_id, book_id::text) partitions standalone books alone
    -- (rank always 1, no penalty); same-series books compete for rank.
    select b.*,
           row_number() over (partition by b.author_id                              order by b.base_score desc) as author_rank,
           row_number() over (partition by coalesce(b.series_id, b.book_id::text)   order by b.base_score desc) as series_rank
    from base_scored b
  )
  select
    d.book_id,
    greatest(0, (d.base_score - 0.15 * (
      case when d.author_rank = 1 then 0.0
           when d.author_rank = 2 then 0.5
           else 1.0 end
      +
      case when d.series_rank = 1 then 0.0
           when d.series_rank = 2 then 0.5
           else 1.0 end
    ) / 2.0))::numeric as final_score,
    d.jaccard_score,
    d.velocity_score,
    d.recency_score,
    (0.15 * (
      case when d.author_rank = 1 then 0.0 when d.author_rank = 2 then 0.5 else 1.0 end
      +
      case when d.series_rank = 1 then 0.0 when d.series_rank = 2 then 0.5 else 1.0 end
    ) / 2.0)::numeric as diversity_penalty,
    d.matched_vibes,
    d.is_cold_start as cold_start_mode
  from diversified d
  order by final_score desc, d.book_id
  limit p_limit;
$$;

-- ============================================================================
-- Grants
-- ============================================================================
grant execute on function public.match_books_to_vibes(
  uuid, text[], text[], text[], text[], text, int, int, uuid[], text[], int
) to anon, authenticated, service_role;

-- ============================================================================
-- Notes
-- ----------------------------------------------------------------------------
-- - Cold-start threshold: corpus-wide sum(saves_count + likes_count) < 100.
--   Once total engagement crosses 100, the function flips to live mode for
--   every subsequent call. There is no per-user gating; it is a global mode.
--
-- - Recency half-life: ~30 days via the constant -0.023 in the exp decay
--   (ln(2)/0.023 ≈ 30.1). To change the half-life, edit the constant in the
--   recency_score expression — it is not currently table-tunable.
--
-- - Weights: tunable at runtime without a migration via
--     update public.vibe_category_weights set weight = X where category = Y;
--   The function reads the table on every call. Defaults if a row is
--   missing: mood 1.0, trope 1.5, aesthetic 0.8, theme 1.2.
--
-- - Pace (p_pace) is intentionally NOT used in scoring. The previous version
--   gave it a 0.15 weight; the BookTok-3 spec drops it. The parameter is
--   retained for compatibility and as a hook for a future hard pace filter
--   if we choose to add one — currently it is unused inside the body.
--
-- - Personalization is deferred. p_user_id is accepted for forward
--   compatibility but unused; the v1 score does not join user_vibe_weights.
--   When personalization lands (v1.5+), add a CTE that pulls the user's
--   weights and folds them into the jaccard or base score.
--
-- - Diversity penalty caps at 0.15 (averaging the author and series
--   penalties, each in {0.0, 0.5, 1.0}, then multiplying by 0.15). Worst
--   case: third+ book from the same author AND same series → -0.15.
--
-- - Author diversity uses author_ids[1] (primary author only). Coauthored
--   books are partitioned by their first-listed author; later coauthors do
--   not affect the penalty.
--
-- - Final score is clamped at 0 (lower bound). Negative pre-clamp values
--   represent worst-case books and are floored — relative ranking is
--   preserved, but UI thresholds operate on a clean 0–1 ceiling.
--
-- - Tied final_scores break by book_id ascending. This is for determinism,
--   not preference; ties imply no meaningful ranking signal between the
--   books.
-- ============================================================================
