import { createClient, SupabaseClient } from 'supabase'

// ─── Types ────────────────────────────────────────────────────────────────

interface MatchRequest {
  moods?:          string[]
  tropes?:         string[]
  aesthetics?:     string[]
  themes?:         string[]
  pace?:           string | null
  spice_min?:      number
  spice_max?:      number
  avoid_book_ids?: string[]
  avoid_cw_tags?:  string[]
  limit?:          number
}

interface RpcRow {
  book_id:           string
  final_score:       number
  jaccard_score:     number
  velocity_score:    number
  recency_score:     number
  diversity_penalty: number
  matched_vibes:     string[]
  cold_start_mode:   boolean
}

interface MatchResult {
  book_id:        string
  title:          string
  subtitle:       string | null
  cover_url:      string | null
  author_names:   string[]
  match_score:    number
  match_quality:  'strong' | 'moderate' | 'weak'
  matched_vibes:  string[]
  components: {
    jaccard:           number
    velocity:          number
    recency:           number
    diversity_penalty: number
  }
}

interface MatchResponse {
  results:         MatchResult[]
  cold_start_mode: boolean
  query_logged_id: string | null
}

type BookRow   = { id: string; title: string; subtitle: string | null; cover_url: string | null; author_ids: string[] | null }
type AuthorRow = { id: string; name: string }

// ─── Helpers ──────────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  })
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))

// Match-quality thresholds calibrated from Phase 2 smoke tests: well-tagged
// books cluster around jaccard ~0.4 in cold-start, with final_score rarely
// exceeding 0.5. Tune by changing the two constants below.
function classifyMatchQuality(score: number): 'strong' | 'moderate' | 'weak' {
  if (score >= 0.4) return 'strong'
  if (score >= 0.2) return 'moderate'
  return 'weak'
}

function parseRequest(raw: unknown): MatchRequest {
  if (typeof raw !== 'object' || raw === null) throw new Error('body must be a JSON object')
  const r = raw as Record<string, unknown>

  const stringArray = (v: unknown, name: string): string[] | undefined => {
    if (v === undefined) return undefined
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) {
      throw new Error(`${name} must be an array of strings`)
    }
    return v
  }
  const numberOrUndef = (v: unknown, name: string): number | undefined => {
    if (v === undefined) return undefined
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`${name} must be a finite number`)
    }
    return v
  }
  const paceField = (v: unknown): string | null | undefined => {
    if (v === undefined) return undefined
    if (v === null) return null
    if (typeof v !== 'string') throw new Error('pace must be a string or null')
    return v
  }

  // Type-validate first, then clamp out-of-range numbers. Bad ranges are
  // silently clamped rather than thrown so client bugs and malicious payloads
  // can't break the response. Clamp ranges mirror the SQL function's expected
  // inputs (0-5 spice, 1-20 limit). limit is also floored since the SQL
  // function expects an int.
  const spiceMin = numberOrUndef(r.spice_min, 'spice_min')
  const spiceMax = numberOrUndef(r.spice_max, 'spice_max')
  const lim      = numberOrUndef(r.limit,     'limit')

  return {
    moods:          stringArray(r.moods,          'moods'),
    tropes:         stringArray(r.tropes,         'tropes'),
    aesthetics:     stringArray(r.aesthetics,     'aesthetics'),
    themes:         stringArray(r.themes,         'themes'),
    pace:           paceField(r.pace),
    spice_min:      spiceMin === undefined ? undefined : clamp(spiceMin, 0, 5),
    spice_max:      spiceMax === undefined ? undefined : clamp(spiceMax, 0, 5),
    avoid_book_ids: stringArray(r.avoid_book_ids, 'avoid_book_ids'),
    avoid_cw_tags:  stringArray(r.avoid_cw_tags,  'avoid_cw_tags'),
    limit:          lim      === undefined ? undefined : clamp(Math.floor(lim), 1, 20),
  }
}

async function getUserId(req: Request, anonClient: SupabaseClient): Promise<string | null> {
  const auth = req.headers.get('Authorization')
  if (!auth) return null
  const token = auth.replace(/^Bearer\s+/i, '')
  const { data, error } = await anonClient.auth.getUser(token)
  if (error || !data.user) return null
  return data.user.id
}

// ─── Handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (req.method !== 'POST')    return jsonResponse({ error: 'method not allowed' }, 405)

  const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')
  const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: 'server misconfigured: missing env vars' }, 500)
  }

  let body: MatchRequest
  try {
    const raw = await req.json()
    body = parseRequest(raw)
  } catch (e) {
    return jsonResponse({ error: `bad request: ${(e as Error).message}` }, 400)
  }

  const supabaseAnon  = createClient(SUPABASE_URL, SUPABASE_ANON_KEY,         { auth: { persistSession: false } })
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

  const userId = await getUserId(req, supabaseAnon)

  const moods      = body.moods          ?? []
  const tropes     = body.tropes         ?? []
  const aesthetics = body.aesthetics     ?? []
  const themes     = body.themes         ?? []
  const avoidIds   = body.avoid_book_ids ?? []
  const avoidCw    = body.avoid_cw_tags  ?? []
  const pace       = body.pace           ?? null
  const spiceMin   = body.spice_min      ?? 0
  const spiceMax   = body.spice_max      ?? 5
  const limit      = body.limit          ?? 3

  // Call the ranking function
  let rpcRows: RpcRow[]
  try {
    const { data, error } = await supabaseAdmin.rpc('match_books_to_vibes', {
      p_user_id:        userId,
      p_moods:          moods,
      p_tropes:         tropes,
      p_aesthetics:     aesthetics,
      p_themes:         themes,
      p_pace:           pace,
      p_spice_min:      spiceMin,
      p_spice_max:      spiceMax,
      p_avoid_book_ids: avoidIds,
      p_avoid_cw_tags:  avoidCw,
      p_limit:          limit,
    })
    if (error) throw error
    rpcRows = (data ?? []) as RpcRow[]
  } catch (e) {
    return jsonResponse({ error: `rpc failed: ${(e as Error).message}` }, 500)
  }

  if (rpcRows.length === 0) {
    return jsonResponse({ results: [], cold_start_mode: false, query_logged_id: null } satisfies MatchResponse)
  }

  // Enrich with display data (single book query, single author query)
  const bookIds = rpcRows.map(r => r.book_id)

  let books: BookRow[] = []
  try {
    const { data, error } = await supabaseAdmin
      .from('books')
      .select('id, title, subtitle, cover_url, author_ids')
      .in('id', bookIds)
    if (error) throw error
    books = (data ?? []) as BookRow[]
  } catch (e) {
    return jsonResponse({ error: `book fetch failed: ${(e as Error).message}` }, 500)
  }

  const allAuthorIds = Array.from(new Set(books.flatMap(b => b.author_ids ?? [])))
  let authors: AuthorRow[] = []
  if (allAuthorIds.length > 0) {
    try {
      const { data, error } = await supabaseAdmin
        .from('authors')
        .select('id, name')
        .in('id', allAuthorIds)
      if (error) throw error
      authors = (data ?? []) as AuthorRow[]
    } catch (e) {
      return jsonResponse({ error: `author fetch failed: ${(e as Error).message}` }, 500)
    }
  }

  const bookMap   = new Map(books.map(b => [b.id, b]))
  const authorMap = new Map(authors.map(a => [a.id, a.name]))

  // Preserve RPC rank order; silently drop any RPC row whose book_id is missing
  // from the books table (shouldn't happen — eligible CTE inner-joins books).
  const results: MatchResult[] = rpcRows
    .map(row => {
      const book = bookMap.get(row.book_id)
      if (!book) return null
      return {
        book_id:       row.book_id,
        title:         book.title,
        subtitle:      book.subtitle,
        cover_url:     book.cover_url,
        author_names:  (book.author_ids ?? []).map(id => authorMap.get(id) ?? 'Unknown'),
        match_score:   row.final_score,
        match_quality: classifyMatchQuality(row.final_score),
        matched_vibes: row.matched_vibes,
        components: {
          jaccard:           row.jaccard_score,
          velocity:          row.velocity_score,
          recency:           row.recency_score,
          diversity_penalty: row.diversity_penalty,
        },
      } satisfies MatchResult
    })
    .filter((r): r is MatchResult => r !== null)

  // Log the query envelope. Service role bypasses owner-only RLS so anonymous
  // queries (user_id = null) still get logged for analytics. pace_slider stays
  // null because the column expects a 1-5 integer; pace as a vibe ID is folded
  // into query_chips alongside other vibe selections so query reconstruction
  // works.
  let queryLoggedId: string | null = null
  try {
    const { data, error } = await supabaseAdmin
      .from('vibe_match_history')
      .insert({
        user_id:         userId,
        query_chips:     [...moods, ...tropes, ...aesthetics, ...themes, ...(pace ? [pace] : [])],
        pace_slider:     null,
        spice_min:       spiceMin,
        spice_max:       spiceMax,
        free_text:       null,
        parsed_filters:  null,
        result_book_ids: results.map(r => r.book_id),
      })
      .select('id')
      .single()
    if (error) throw error
    queryLoggedId = data.id
  } catch (e) {
    // Logging failure should not break the user-facing response.
    console.error('vibe_match_history insert failed:', (e as Error).message)
  }

  return jsonResponse({
    results,
    cold_start_mode: rpcRows[0].cold_start_mode,
    query_logged_id: queryLoggedId,
  } satisfies MatchResponse)
})
