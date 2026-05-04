# BookTok

An AI-powered book discovery app that matches readers to books based on **vibes** — mood, tropes, themes, and aesthetics — rather than traditional genre browsing.

## Overview

BookTok surfaces books by analyzing vibe profiles extracted from book descriptions using LLMs. A custom ranking algorithm scores each book using tag-weighted Jaccard similarity, engagement velocity, and recency decay to serve personalized, ranked recommendations.

The corpus is seeded with 1,116 books. Vibe profiles are extracted via Anthropic Claude and stored in Supabase (PostgreSQL). Recommendations are served through a Deno edge function deployed on Supabase.

## Tech Stack

| Layer | Technology |
|---|---|
| Database | Supabase (PostgreSQL) |
| Edge Functions | Deno (Supabase Edge Runtime) |
| Backend Scripts | TypeScript / Node.js |
| AI / LLM | Anthropic Claude (`@anthropic-ai/sdk`) |
| Migrations | Supabase CLI |

## Project Structure

```
BookTok/
├── backend/
│   ├── functions/
│   │   └── match-vibes/       # Edge function: vibe-based book ranking
│   ├── migrations/            # Supabase SQL migrations (source of truth)
│   ├── scripts/               # Seeding, vibe extraction, and test scripts
│   └── seed/                  # Book and vocabulary seed data
├── docs/                      # Design docs and specs
├── supabase/                  # Supabase CLI config (symlinked to backend/)
├── CLAUDE.md                  # Agent instructions and schema integrity notes
└── SESSION_NOTES.md           # Per-session build logs
```

## Core Feature: Match Vibes

The `match-vibes` edge function accepts vibe inputs (mood, tropes, themes, aesthetics, spice level) and returns a ranked list of books using the **BookTok-3 ranking spec**:

- **Tag-weighted Jaccard similarity** — trope `1.5x`, theme `1.2x`, mood `1.0x`, aesthetic `0.8x`
- **Engagement velocity** — min-max normalized saves/likes with exp-decay recency (~30-day half-life)
- **Mode-aware scoring** — cold-start vs. warm corpus modes
- **Diversity penalty** — author/series diversity to avoid result clustering
- **Match quality classification** — `strong` (≥ 0.4), `moderate` (≥ 0.2), `weak`

**Endpoint:** `${SUPABASE_URL}/functions/v1/match-vibes`

## Database

Migrations live in `backend/migrations/` and are symlinked into `supabase/migrations/` for CLI compatibility. Key tables:

- `books` — book catalog with vibe profiles and engagement counters
- `vibe_category_weights` — runtime-tunable weights for Jaccard scoring
- `vibe_match_history` — query envelope logging for analytics

## Local Development

```bash
# Install dependencies
cd backend && npm install

# Seed vocabulary and books
npm run seed:vocab
npm run seed:books

# Extract vibe profiles from book descriptions (uses Anthropic API)
npm run extract:vibes

# Run tests for match-vibes
npm run test:match
```

## Deploying Edge Functions

```bash
# From repo root
supabase functions deploy match-vibes --no-verify-jwt --linked
```

> **Note:** Run all `supabase` CLI commands from the **repo root**, not from `backend/`. The CLI resolves project ref from the working directory.

## Environment Variables

User-defined secrets are set via:
```bash
supabase secrets set ANTHROPIC_API_KEY=your_key
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by the Supabase runtime — do not set these manually.

## Schema Integrity

See [CLAUDE.md](./CLAUDE.md) for schema integrity protocols. Always run `information_schema.columns` and `pg_proc` inspection queries before destructive DDL to catch out-of-band schema drift.
