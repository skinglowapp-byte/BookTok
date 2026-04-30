## Schema integrity

The remote Supabase DB has a history of out-of-band schema additions made via Studio SQL editor during early iteration that were never tracked in `backend/migrations/`. Two have been surfaced and corrected so far:

- **0006 → 0007**: `books.first_seen_at` existed with the wrong type (`timestamp` instead of `timestamptz`) and wrong nullability (nullable instead of NOT NULL). `add column if not exists` silently preserved the bad definition; 0007 corrected it.
- **0008 → 0009**: an 8-parameter `match_books_to_vibes` overload existed alongside the 11-parameter version defined in 0004. 0008's targeted `drop function if exists` skipped the unrelated overload, leaving Postgres unable to resolve calls. 0009 dropped it explicitly.

Treat the remote schema as potentially divergent from migrations until proven otherwise. Before destructive or definition-changing DDL:

- **Before `alter table <t>`**, run:
  ```sql
  select column_name, data_type, is_nullable
  from information_schema.columns
  where table_schema = 'public' and table_name = '<t>'
  order by ordinal_position;
  ```
  Confirm columns exist with the expected types and nullability before relying on `add column if not exists` / `alter column` semantics.

- **Before `create function <f>`**, run:
  ```sql
  select pg_get_function_arguments(oid), pg_get_function_result(oid)
  from pg_proc
  where proname = '<f>';
  ```
  Multiple rows mean orphan overloads exist. `create or replace function` only matches on full signature — orphans must be dropped explicitly.

A full `pg_dump --schema-only` diff against the union of applied migrations is queued as cleanup work after Phase 4. Until that lands, assume more out-of-band objects may exist and verify before acting.

## Edge functions

**`SUPABASE_` prefix is reserved at runtime.** Edge functions auto-receive `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from the Supabase runtime — these cannot be set manually via `supabase secrets set` (the CLI rejects any name starting with `SUPABASE_` with `Env name cannot start with SUPABASE_, skipping`). An empty `supabase secrets list` is the expected state for functions that only consume those three. User-defined secrets (e.g., `ANTHROPIC_API_KEY`) use the normal `supabase secrets set NAME=VALUE` path.

**Symlink convention for function deploys.** The Supabase CLI only deploys from `supabase/functions/<name>/`, but project source-of-truth lives in `backend/functions/`. A symlink `supabase/functions -> ../backend/functions` bridges this, mirroring the same pattern used for `supabase/migrations -> ../backend/migrations`. New edge functions just go in `backend/functions/<name>/` and are picked up automatically — no need to duplicate files or move them.

**`supabase` CLI resolves `--linked` from cwd.** After `npm run` from `backend/`, you're still in `backend/` — subsequent `supabase` commands fail with `Cannot find project ref` because the CLI walks the cwd looking for `supabase/`. Either `cd` back to the repo root or pass `--workdir /Users/mohamedsaleh/Desktop/Business/MoLabs/BookTok` explicitly.
