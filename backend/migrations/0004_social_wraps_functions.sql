-- Migration 0004: Social, wraps, and matching helper functions
-- Depends on: 0001, 0002, 0003

-- ============================================================================
-- follows
-- Lightweight social: who follows whom. Asymmetric (Twitter-style).
-- ============================================================================
create table public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (follower_id, following_id),
  check (follower_id != following_id)
);

create index follows_follower_idx on public.follows (follower_id);
create index follows_following_idx on public.follows (following_id);

-- ============================================================================
-- wraps
-- Generated wrap card metadata. PNG itself stored in Supabase Storage.
-- ============================================================================
create table public.wraps (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  period_type text not null,                       -- 'month' | 'year' | 'custom'
  period_start date not null,
  period_end date not null,
  theme text not null default 'minimalist_cream',
  stats jsonb not null,                            -- { books_read, avg_rating, top_vibe, spiciest_book_id, etc }
  image_url text,                                  -- Supabase Storage URL
  generated_at timestamptz default now(),
  share_count int default 0,
  unique (user_id, period_type, period_start, period_end)
);

create index wraps_user_idx on public.wraps (user_id, period_start desc);

-- ============================================================================
-- imports
-- Tracks Goodreads CSV imports for debugging and re-imports.
-- ============================================================================
create table public.imports (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source text not null,                            -- 'goodreads_csv' | 'storygraph_csv' | etc.
  status text not null default 'pending',          -- 'pending' | 'processing' | 'complete' | 'failed'
  total_rows int,
  matched_rows int,                                -- rows we successfully matched to books
  unmatched_rows int,
  error_log jsonb,
  started_at timestamptz default now(),
  completed_at timestamptz
);

create index imports_user_idx on public.imports (user_id, started_at desc);

-- ============================================================================
-- match_books_to_vibes
-- Core ranking function. Returns top N books matching the given vibe filters,
-- scored according to the algorithm in /docs/match-algorithm.md.
--
-- Inputs:
--   p_user_id - current user (for personalization weights and content warnings)
--   p_moods, p_tropes, p_aesthetics, p_themes - desired vibe ids
--   p_pace - desired pace (or null)
--   p_spice_min, p_spice_max - spice range
--   p_avoid_book_ids - books to exclude (already read, skipped, etc.)
--   p_only_in_shelf - if set, only return books on this shelf for the user
--   p_limit - how many to return (default 10)
-- ============================================================================
create or replace function public.match_books_to_vibes(
  p_user_id uuid,
  p_moods text[] default '{}',
  p_tropes text[] default '{}',
  p_aesthetics text[] default '{}',
  p_themes text[] default '{}',
  p_pace text default null,
  p_spice_min int default 0,
  p_spice_max int default 5,
  p_avoid_book_ids uuid[] default '{}',
  p_only_in_shelf uuid default null,
  p_limit int default 10
)
returns table (
  book_id uuid,
  score numeric,
  mood_match numeric,
  trope_match numeric,
  pace_match numeric,
  spice_match numeric,
  theme_match numeric,
  matched_vibes text[]
)
language plpgsql
stable
as $$
begin
  return query
  with candidates as (
    select bv.*
    from public.book_vibes bv
    where
      -- Spice range filter (hard)
      (bv.spice_level is null or bv.spice_level between p_spice_min and p_spice_max)
      -- Exclude avoid list
      and not (bv.book_id = any(p_avoid_book_ids))
      -- Optional: limit to a specific shelf for the user
      and (
        p_only_in_shelf is null or
        exists (
          select 1 from public.shelf_items si
          where si.shelf_id = p_only_in_shelf and si.book_id = bv.book_id
        )
      )
      -- Exclude books with content warnings the user has filtered
      and not exists (
        select 1
        from public.user_content_warning_filters f,
             jsonb_array_elements(bv.content_warnings) cw
        where f.user_id = p_user_id
          and (cw->>'tag') = f.warning_id
          and (
            f.block_at_severity = 'any'
            or (f.block_at_severity = 'moderate' and cw->>'severity' in ('graphic','moderate'))
            or (f.block_at_severity = 'graphic' and cw->>'severity' = 'graphic')
          )
      )
  ),
  scored as (
    select
      c.book_id,
      -- Mood: jaccard similarity
      case when array_length(p_moods, 1) > 0 then
        coalesce(
          array_length(array(select unnest(c.moods) intersect select unnest(p_moods)), 1)::numeric /
          nullif(array_length(array(select unnest(c.moods) union select unnest(p_moods)), 1), 0),
          0
        )
      else 0 end as mood_match,

      -- Trope: same, but exact matches weight higher
      case when array_length(p_tropes, 1) > 0 then
        coalesce(
          array_length(array(select unnest(c.tropes) intersect select unnest(p_tropes)), 1)::numeric /
          nullif(array_length(p_tropes, 1), 0),
          0
        )
      else 0 end as trope_match,

      -- Pace: 1.0 if exact, 0.5 if adjacent (slow~quiet, fast~unputdownable), else 0
      case
        when p_pace is null then 0
        when c.pace = p_pace then 1.0
        when (p_pace = 'pace_slow' and c.pace = 'quiet') then 0.5
        when (p_pace = 'pace_fast' and c.pace = 'unputdownable') then 0.5
        when (p_pace = 'unputdownable' and c.pace = 'pace_fast') then 0.5
        else 0
      end as pace_match,

      -- Spice: already filtered hard, so any candidate gets 1.0
      1.0::numeric as spice_match,

      -- Theme: jaccard
      case when array_length(p_themes, 1) > 0 then
        coalesce(
          array_length(array(select unnest(c.themes) intersect select unnest(p_themes)), 1)::numeric /
          nullif(array_length(array(select unnest(c.themes) union select unnest(p_themes)), 1), 0),
          0
        )
      else 0 end as theme_match,

      -- Personal weight: average of user's weights for matched vibes
      coalesce((
        select avg(uvw.weight)
        from public.user_vibe_weights uvw
        where uvw.user_id = p_user_id
          and uvw.vibe_id = any(c.moods || c.tropes || c.themes)
      ), 0) as personal_signal,

      c.moods || c.tropes || c.aesthetics || c.themes as all_vibes
    from candidates c
  )
  select
    s.book_id,
    -- Composite score per algorithm spec
    (
      0.35 * s.mood_match +
      0.25 * s.trope_match +
      0.15 * s.pace_match +
      0.10 * s.spice_match +
      0.10 * s.theme_match +
      0.05 * (s.personal_signal + 1) / 2  -- normalize personal_signal from [-1,1] to [0,1]
    ) as score,
    s.mood_match,
    s.trope_match,
    s.pace_match,
    s.spice_match,
    s.theme_match,
    array(
      select v from unnest(s.all_vibes) v
      where v = any(p_moods || p_tropes || p_aesthetics || p_themes)
    ) as matched_vibes
  from scored s
  where (
    s.mood_match + s.trope_match + s.pace_match + s.theme_match
  ) > 0  -- exclude books that don't match anything
  order by score desc
  limit p_limit;
end;
$$;

-- ============================================================================
-- update_user_vibe_weights
-- Called from app code when a user rates, DNFs, or skips a book.
-- Adjusts personal weights for the book's vibes based on signal direction.
-- ============================================================================
create or replace function public.update_user_vibe_weights(
  p_user_id uuid,
  p_book_id uuid,
  p_signal text                    -- 'rated_high' | 'rated_low' | 'dnf' | 'added_tbr' | 'skipped'
)
returns void
language plpgsql
as $$
declare
  v_delta numeric;
  v_vibe text;
  v_book_vibes text[];
begin
  -- Determine signal magnitude
  v_delta := case p_signal
    when 'rated_high' then 0.10
    when 'rated_low' then -0.10
    when 'dnf' then -0.15
    when 'added_tbr' then 0.03
    when 'skipped' then -0.05
    else 0
  end;

  if v_delta = 0 then return; end if;

  -- Pull the book's vibes
  select moods || tropes || themes into v_book_vibes
  from public.book_vibes
  where book_id = p_book_id;

  if v_book_vibes is null then return; end if;

  -- Upsert weight for each vibe
  foreach v_vibe in array v_book_vibes loop
    insert into public.user_vibe_weights (user_id, vibe_id, weight, interaction_count)
    values (p_user_id, v_vibe, greatest(-1.0, least(1.0, v_delta)), 1)
    on conflict (user_id, vibe_id) do update
    set
      weight = greatest(-1.0, least(1.0, public.user_vibe_weights.weight + v_delta)),
      interaction_count = public.user_vibe_weights.interaction_count + 1,
      updated_at = now();
  end loop;
end;
$$;

-- ============================================================================
-- RLS
-- ============================================================================
alter table public.follows enable row level security;
alter table public.wraps enable row level security;
alter table public.imports enable row level security;

create policy follows_select_all on public.follows
  for select using (true);

create policy follows_owner_write on public.follows
  for all using (auth.uid() = follower_id);

create policy wraps_owner on public.wraps
  for all using (auth.uid() = user_id);

create policy wraps_public_read on public.wraps
  for select using (true);  -- wraps are public by default; user can keep image private separately

create policy imports_owner on public.imports
  for all using (auth.uid() = user_id);
