# BookTok App — Backend Migrations

## Run order

Apply migrations in numeric order. Each depends on the previous.

```
0001_core_tables.sql              # extensions, profiles, authors, books
0002_vibes.sql                    # vibe vocabulary, book_vibes, personalization
0003_shelves_ratings_reviews.sql  # shelves, shelf_items, ratings, reviews, sessions
0004_social_wraps_functions.sql   # follows, wraps, imports, match function
```

## How to apply

### Local dev (Supabase CLI)
```bash
supabase init                     # if not yet initialized
supabase start                    # spin up local Postgres
supabase db push                  # applies all migrations in /backend/migrations
```

### Production
```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

## After migrations: seed the vibe vocabulary

The vocabulary is stored in `/docs/vibe-vocabulary.json`. Load it into the `vibes` table once after migrations run.

Run this from a Supabase Edge Function or a one-off Node script:

```typescript
import { createClient } from '@supabase/supabase-js'
import vocabulary from '../docs/vibe-vocabulary.json'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const rows = vocabulary.vibes.map(v => ({
  id: v.id,
  display: v.display,
  category: v.category,
  spice_value: v.value ?? null,
  aliases: v.aliases ?? [],
  related: v.related ?? [],
  popularity: v.popularity ?? null,
}))

const { error } = await supabase.from('vibes').upsert(rows)
if (error) throw error
console.log(`Seeded ${rows.length} vibes.`)
```

## Then: seed initial books

Pull top books from Open Library:

```bash
# Run once after vocabulary is seeded
deno run --allow-net --allow-env backend/seed/seed-books.ts --count 1000
```

This populates `books` and `authors`. Vibe extraction runs as a separate background job — see `/backend/functions/extract-vibes/`.

## Quick verification queries

After seeding, run these in the Supabase SQL editor:

```sql
-- Should return 111
select count(*) from vibes;

-- Distribution by category
select category, count(*) from vibes group by category order by count(*) desc;

-- Top 20 most-popular vibes
select display, popularity from vibes
where popularity is not null
order by popularity desc limit 20;

-- Confirm pgvector and trigram are active
select extname from pg_extension where extname in ('vector', 'pg_trgm', 'uuid-ossp');
```

## Notes for Claude Code sessions

- **Never edit a migration after it has been applied to prod.** Create a new numbered migration instead.
- The `match_books_to_vibes` function is the core ranking engine. If you change its signature, update `/backend/functions/match-vibes/` too.
- Vibe vocabulary changes go through migration: write `0005_vocab_update.sql` that does `INSERT ... ON CONFLICT UPDATE` against `vibes`, then update `/docs/vibe-vocabulary.json` to match.
- All AI calls (Claude Haiku, embeddings) live in edge functions, never in the Flutter app.
