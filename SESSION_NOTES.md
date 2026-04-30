# match-vibes build session — 2026-04-30

## What was built

- **Migration [0006_match_vibes_columns.sql](backend/migrations/0006_match_vibes_columns.sql)** — additive: `books.saves_count`, `books.likes_count`, `books.first_seen_at`, `books.series_id` (with indexes); new `vibe_category_weights` table seeded with `trope 1.5 / theme 1.2 / mood 1.0 / aesthetic 0.8`; RLS world-readable.
- **Migration [0007_fix_first_seen_at.sql](backend/migrations/0007_fix_first_seen_at.sql)** — corrected `books.first_seen_at` from `timestamp` → `timestamptz` and `nullable` → `NOT NULL` after discovering 0006's `add column if not exists` had silently preserved an out-of-band column with the wrong shape. Existing values cast through `at time zone 'UTC'`.
- **Migration [0008_match_books_to_vibes_v2.sql](backend/migrations/0008_match_books_to_vibes_v2.sql)** — full rewrite of the ranking RPC for the BookTok-3 spec: tag-weighted Jaccard, min-max-normalized velocity, exp-decay recency (~30-day half-life), mode-aware base score (cold-start: `0.70·jaccard + 0.15·recency`; warm: `0.50·jaccard + 0.20·velocity + 0.15·recency`), author/series diversity penalty (max 0.15, averaged), final-score clamped to ≥0, deterministic `(final_score desc, book_id)` ordering.
- **Migration [0009_drop_match_books_to_vibes_overload.sql](backend/migrations/0009_drop_match_books_to_vibes_overload.sql)** — dropped an 8-parameter `match_books_to_vibes` overload that existed out-of-band in the remote DB and made overload resolution ambiguous. Zero callers in repo.
- **Edge function [backend/functions/match-vibes/](backend/functions/match-vibes/)** (`index.ts` + `deno.json`) — Deno HTTP handler: input validation + clamping, JWT-aware (anonymous-friendly) auth, RPC call, book/author enrichment preserving rank order, `match_quality` classification (`strong ≥ 0.4`, `moderate ≥ 0.2`, `weak`), `vibe_match_history` query envelope logging. Deployed at `${SUPABASE_URL}/functions/v1/match-vibes` with `--no-verify-jwt`.
- **Symlink `supabase/functions -> ../backend/functions`** — mirrors the existing `supabase/migrations -> ../backend/migrations` pattern so the Supabase CLI can find functions while source-of-truth stays in `backend/`.
- **Test harness [backend/scripts/test-match-vibes.ts](backend/scripts/test-match-vibes.ts)** — 8 tests, all passing. Wired up as `npm run test:match`.

## Verified end-to-end

The harness exercises the full request → response → side-effect chain across both ranking modes:

- **HTTP contract** — request validation (test 6, invalid input → 400 with the expected error message), input clamping (test 5, out-of-range numeric inputs silently corrected), success status (tests 1–5, 7, 8).
- **SQL function correctness** — cold-start formula and thresholds (tests 1, 4), `(final_score desc, book_id)` determinism across calls (test 2), spice range filter actually filters (test 3), warm-mode flip and velocity normalization (test 8).
- **Side effects** — `vibe_match_history` insert succeeds for anonymous queries via service role bypass (test 7); test 8's `try/finally` restores the boosted `saves_count` even on assertion failure (verified afterwards: `count(*) where saves_count > 0` returned `0`).
- **Enrichment** — book and author lookups preserve the RPC's rank order; manual smoke test confirmed `match_score`, `jaccard`, `recency`, `velocity` traced identically from SQL function output to HTTP response.

## Queued follow-ups

- **`0010_drop_books_orphan_columns.sql`** — drop `books.tags`, `books.saves`, `books.likes`. All three are out-of-band, populated with abandoned test fixtures, zero callers (verified by grep across `mobile/`, `backend/`, docs). Deferred from this session to avoid mid-feature schema churn.
- **Schema audit** — full `pg_dump --schema-only` diff against the union of applied migrations to find any other out-of-band objects we haven't tripped over yet. Three drift incidents this session (`first_seen_at` type, rogue function overload, orphan columns) suggests there may be more.
- **Description enrichment for the 121 sparse-input books** — separate session. Currently these books are excluded from the eligible set by `bv.confidence >= 0.4`. Enriching their descriptions and re-running [extract-vibes.ts](backend/scripts/extract-vibes.ts) is the path from ~88% to ~99% extraction coverage.
- **Component-score logging in `vibe_match_history`** — deliberately deferred. Without real users generating behavioral data, per-result component logs are theater. Revisit at v1.5 when there's enough engagement to A/B test against.

## Known calibration to revisit

- **`match_quality` thresholds** (`0.4` / `0.2`) — calibrated on a single smoke test. Top results clustering at `0.42` suggested `0.4` for `strong`, but the line between `strong` and `moderate` is the most subjective and will likely need tuning once real onboarding queries hit the function.
- **Romance-adjacent moods/tropes sets** in [extract-vibes.ts](backend/scripts/extract-vibes.ts) — the spice/romance mismatch warning (spice ≥ 3 with no romance signal in moods/tropes) uses a hardcoded set. If warm-mode writes start showing >5% mismatch warnings, expand the romance-tag list rather than lowering the threshold.
- **`vibe_category_weights`** (`trope 1.5 / theme 1.2 / mood 1.0 / aesthetic 0.8`) — tunable at runtime via plain `update public.vibe_category_weights set weight = X where category = Y;` with no migration. Once we have query → tap-through data we can A/B these weights without redeploy.
- **Cold-start threshold** (corpus-wide `saves + likes < 100`) — global mode, not per-user. Once the corpus warms past 100, every call flips to live mode permanently. Reconsider if early users skew the global counter before the corpus is genuinely warm enough to support velocity-driven ranking.
- **Recency half-life** (~30 days, via the `-0.023` constant in `exp(-0.023 · days)`) — currently a literal in [0008_match_books_to_vibes_v2.sql](backend/migrations/0008_match_books_to_vibes_v2.sql). To make tunable without a migration, would need to fold it into `vibe_category_weights` or a new `match_constants` table.

## Schema integrity reminders

Three out-of-band schema additions surfaced this session:

- `books.first_seen_at` had drifted from spec (`timestamp` nullable instead of `timestamptz` NOT NULL). Caught by post-apply verification queries; corrected in 0007.
- A second `match_books_to_vibes` overload (8-param, returning `title`/`cover_url`/etc.) existed alongside 0004's 11-param version. Caught by post-apply smoke test failing on overload resolution; corrected in 0009.
- `books.tags`, `books.saves`, `books.likes` exist as orphan columns populated with abandoned test fixtures. Discovered during Phase 3 recon; deferred for cleanup as `0010`.

The schema-integrity protocol is now codified in [CLAUDE.md](CLAUDE.md). Future sessions should run `information_schema.columns` and `pg_proc` inspections before any destructive or definition-changing DDL — both checks would have caught the first-two incidents pre-apply.
