-- Migration 0002: Vibe system tables
-- Depends on: 0001_core_tables.sql
-- The vocabulary itself is loaded from /docs/vibe-vocabulary.json via seed script.

-- ============================================================================
-- vibes
-- Master vocabulary. Mirrors /docs/vibe-vocabulary.json.
-- Updated via migration when vocabulary changes; never edited directly in prod.
-- ============================================================================
create table public.vibes (
  id text primary key,                              -- e.g. 'morally_gray'
  display text not null,                            -- e.g. 'morally gray'
  category text not null,                           -- 'mood' | 'trope' | 'aesthetic' | 'pace' | 'spice' | 'theme' | 'content_warning'
  spice_value int,                                  -- only set for category='spice', 1-5
  aliases text[] default '{}',
  related text[] default '{}',                      -- references vibes.id
  popularity numeric(3,2),                          -- 0-1, null for content_warning
  created_at timestamptz default now()
);

create index vibes_category_idx on public.vibes (category);
create index vibes_popularity_idx on public.vibes (popularity desc);

-- Constraint: spice category must have spice_value, others must not
alter table public.vibes add constraint vibes_spice_value_check
  check (
    (category = 'spice' and spice_value between 1 and 5) or
    (category != 'spice' and spice_value is null)
  );

-- ============================================================================
-- book_vibes
-- The AI-generated vibe profile for each book.
-- One row per book. Regenerated when book metadata or top reviews change significantly.
-- ============================================================================
create table public.book_vibes (
  book_id uuid primary key references public.books(id) on delete cascade,
  moods text[] default '{}',                        -- references vibes.id where category='mood'
  tropes text[] default '{}',
  aesthetics text[] default '{}',
  pace text,                                        -- 'pace_slow' | 'pace_medium' | 'pace_fast' | 'unputdownable' | 'quiet' | etc.
  spice_level int,                                  -- 0-5 (0 = no romance content)
  themes text[] default '{}',
  content_warnings jsonb default '[]'::jsonb,       -- [{tag, severity}] where severity in ('graphic','moderate','mentioned')
  embedding vector(1536),                           -- OpenAI text-embedding-3-small dimensions
  confidence numeric(3,2),                          -- 0-1, from extraction
  reasoning text,                                   -- one-sentence summary from extraction
  model_version text,                               -- e.g. 'claude-haiku-4-5-20251001'
  generated_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index book_vibes_moods_idx on public.book_vibes using gin (moods);
create index book_vibes_tropes_idx on public.book_vibes using gin (tropes);
create index book_vibes_aesthetics_idx on public.book_vibes using gin (aesthetics);
create index book_vibes_themes_idx on public.book_vibes using gin (themes);
create index book_vibes_pace_idx on public.book_vibes (pace);
create index book_vibes_spice_idx on public.book_vibes (spice_level);

-- Vector similarity index (HNSW for fast approximate nearest neighbor)
create index book_vibes_embedding_idx on public.book_vibes
  using hnsw (embedding vector_cosine_ops);

alter table public.book_vibes add constraint book_vibes_spice_check
  check (spice_level is null or spice_level between 0 and 5);

-- ============================================================================
-- user_vibe_weights
-- Personal weight multipliers per user, learned from rating/DNF/skip behavior.
-- Sparse: only stores vibes the user has interacted with.
-- ============================================================================
create table public.user_vibe_weights (
  user_id uuid not null references public.profiles(id) on delete cascade,
  vibe_id text not null references public.vibes(id) on delete cascade,
  weight numeric(4,2) default 0.0,                  -- range -1.0 to 1.0
  interaction_count int default 0,
  updated_at timestamptz default now(),
  primary key (user_id, vibe_id)
);

create index user_vibe_weights_user_idx on public.user_vibe_weights (user_id);

-- ============================================================================
-- user_content_warning_filters
-- Which content warnings each user wants to filter out, and at what severity.
-- ============================================================================
create table public.user_content_warning_filters (
  user_id uuid not null references public.profiles(id) on delete cascade,
  warning_id text not null,                         -- e.g. 'cw_sa'
  block_at_severity text not null default 'graphic', -- 'graphic' | 'moderate' | 'any'
  created_at timestamptz default now(),
  primary key (user_id, warning_id)
);

-- ============================================================================
-- vibe_match_history
-- Log every Vibe Match query for personalization training and analytics.
-- ============================================================================
create table public.vibe_match_history (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(id) on delete cascade,
  query_chips text[] default '{}',                  -- selected vibe ids
  pace_slider int,                                  -- 1-5
  spice_min int,
  spice_max int,
  free_text text,
  parsed_filters jsonb,                             -- the LLM-parsed structured filters if free_text
  result_book_ids uuid[] default '{}',
  selected_book_id uuid references public.books(id),  -- which result they tapped, if any
  created_at timestamptz default now()
);

create index vibe_match_history_user_idx on public.vibe_match_history (user_id, created_at desc);

-- ============================================================================
-- RLS
-- ============================================================================
alter table public.vibes enable row level security;
alter table public.book_vibes enable row level security;
alter table public.user_vibe_weights enable row level security;
alter table public.user_content_warning_filters enable row level security;
alter table public.vibe_match_history enable row level security;

create policy vibes_select_all on public.vibes
  for select using (true);

create policy book_vibes_select_all on public.book_vibes
  for select using (true);

create policy user_vibe_weights_own on public.user_vibe_weights
  for all using (auth.uid() = user_id);

create policy user_cw_filters_own on public.user_content_warning_filters
  for all using (auth.uid() = user_id);

create policy vibe_match_history_own on public.vibe_match_history
  for all using (auth.uid() = user_id);
