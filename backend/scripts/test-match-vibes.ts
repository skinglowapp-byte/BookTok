import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
config({ path: resolve(ROOT, '.env.local') })

const SUPABASE_URL              = process.env.SUPABASE_URL
const SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL, SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/match-vibes`

// ─── Response types (mirror the edge function's contract) ────────────────

interface MatchResult {
  book_id:       string
  title:         string | null
  subtitle:      string | null
  cover_url:     string | null
  author_names:  string[]
  match_score:   number
  match_quality: 'strong' | 'moderate' | 'weak'
  matched_vibes: string[]
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

interface ErrorResponse { error: string }

type ResponseBody = MatchResponse | ErrorResponse

// ─── HTTP and assertion helpers ──────────────────────────────────────────

async function callMatchVibes(body: unknown): Promise<{ status: number; data: ResponseBody }> {
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Authorization':  `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type':   'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json() as ResponseBody
  return { status: res.status, data }
}

function assertOk(data: ResponseBody): asserts data is MatchResponse {
  if ('error' in data) throw new Error(`expected success, got error: ${data.error}`)
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// ─── Test cases ──────────────────────────────────────────────────────────

const GENERIC_QUERY = {
  moods:  ['cozy', 'tender'],
  tropes: ['enemies_to_lovers', 'slow_burn'],
  themes: ['friendship'],
  limit:  3,
}

async function test1_genericQuery(): Promise<void> {
  const { status, data } = await callMatchVibes(GENERIC_QUERY)
  assertEqual(status, 200, 'status')
  assertOk(data)
  assertEqual(data.results.length, 3, 'result count')
  assertEqual(data.results[0].match_quality, 'strong', 'top match_quality')
  for (const r of data.results) {
    assert(r.title != null && r.title !== '', `title missing on ${r.book_id}`)
  }
}

async function test2_determinism(): Promise<void> {
  const a = await callMatchVibes(GENERIC_QUERY)
  const b = await callMatchVibes(GENERIC_QUERY)
  assertOk(a.data); assertOk(b.data)
  const idsA = a.data.results.map(r => r.book_id).join(',')
  const idsB = b.data.results.map(r => r.book_id).join(',')
  assertEqual(idsA, idsB, 'book_id order across two calls')
}

async function test3_spiceFilter(): Promise<void> {
  // Use a wider limit (20) for both so the filter has room to manifest.
  // At limit:3 both could saturate even when the filter is active.
  const baselineBody  = { ...GENERIC_QUERY, limit: 20 }
  const filteredBody  = { ...baselineBody, spice_min: 4, spice_max: 5 }
  const baseline = await callMatchVibes(baselineBody)
  const filtered = await callMatchVibes(filteredBody)
  assertEqual(filtered.status, 200, 'status')
  assertOk(baseline.data); assertOk(filtered.data)
  assert(
    filtered.data.results.length <= baseline.data.results.length,
    `filtered count (${filtered.data.results.length}) should be <= baseline count (${baseline.data.results.length})`,
  )
  for (const r of filtered.data.results) {
    assert(r.match_score > 0, `match_score should be > 0 for ${r.book_id}, got ${r.match_score}`)
  }
}

async function test4_emptyInput(): Promise<void> {
  // No chips: jaccard goes to 0 for every book; cold-start formula caps at
  // 0.70*0 + 0.15*recency = 0.15 max → all results 'weak' under threshold 0.2.
  const { status, data } = await callMatchVibes({ limit: 3 })
  assertEqual(status, 200, 'status')
  assertOk(data)
  assertEqual(data.results.length, 3, 'result count')
  for (const r of data.results) {
    assertEqual(r.match_quality, 'weak', `match_quality on ${r.book_id} (score=${r.match_score})`)
  }
}

async function test5_outOfRangeClamp(): Promise<void> {
  const { status, data } = await callMatchVibes({
    moods:     ['cozy', 'tender'],
    spice_min: 99,
    spice_max: 200,
    limit:     99999,
  })
  assertEqual(status, 200, 'status (should clamp, not 400)')
  assertOk(data)
  assert(data.results.length <= 20, `limit should clamp to <=20, got ${data.results.length}`)
}

async function test6_invalidInput(): Promise<void> {
  const { status, data } = await callMatchVibes({ moods: 'not an array' })
  assertEqual(status, 400, 'status')
  assert('error' in data, 'response should have error field')
  if ('error' in data) {
    assert(
      data.error.includes('moods must be an array of strings'),
      `error message should mention 'moods must be an array of strings', got: ${data.error}`,
    )
  }
}

async function test7_anonymousLogging(): Promise<void> {
  // Anon-key bearer token (no user JWT) — server-side getUser() returns no
  // user, so userId stays null. Service role still inserts the history row.
  const { data } = await callMatchVibes({ moods: ['cozy'], limit: 1 })
  assertOk(data)
  assert(data.query_logged_id !== null, 'query_logged_id should be non-null for anonymous queries')
  assert(typeof data.query_logged_id === 'string', `query_logged_id should be a string, got ${typeof data.query_logged_id}`)
}

async function test8_warmModeForced(supabase: SupabaseClient): Promise<void> {
  // Pick a book that scores well on the generic query — boosting it ensures
  // it stays in the eligible set after re-query, so velocity normalization
  // surfaces in the response rather than stranding off-result.
  const probe = await callMatchVibes(GENERIC_QUERY)
  assertOk(probe.data)
  if (probe.data.results.length === 0) throw new Error('probe query returned no eligible books')
  const targetBookId = probe.data.results[0].book_id

  const { error: updateErr } = await supabase
    .from('books')
    .update({ saves_count: 200 })
    .eq('id', targetBookId)
  if (updateErr) throw new Error(`failed to set saves_count: ${updateErr.message}`)

  try {
    const { data } = await callMatchVibes(GENERIC_QUERY)
    assertOk(data)
    assertEqual(data.cold_start_mode, false, 'cold_start_mode (corpus saves > 100 threshold)')
    assert(
      data.results.some(r => r.components.velocity > 0),
      'at least one result should have velocity > 0 once warm mode is active',
    )
    const boosted = data.results.find(r => r.book_id === targetBookId)
    if (boosted) {
      assert(
        boosted.components.velocity > 0,
        `boosted book should have velocity > 0, got ${boosted.components.velocity}`,
      )
    }
  } finally {
    // Restore original state. Critical path — surfaces loudly if it fails.
    const { error: restoreErr } = await supabase
      .from('books')
      .update({ saves_count: 0 })
      .eq('id', targetBookId)
    if (restoreErr) {
      console.error(`\n[CRITICAL] Failed to restore saves_count for ${targetBookId}: ${restoreErr.message}`)
      console.error(`Manual fix: update public.books set saves_count = 0 where id = '${targetBookId}';`)
    }
  }
}

// ─── Runner ──────────────────────────────────────────────────────────────

interface NamedTest { name: string; fn: () => Promise<void> }

async function runTests(tests: NamedTest[]): Promise<{ passed: number; failed: number }> {
  let passed = 0
  let failed = 0
  for (const t of tests) {
    process.stdout.write(`  ${t.name} ... `)
    try {
      await t.fn()
      console.log('✓')
      passed++
    } catch (e) {
      console.log(`✗\n      ${(e as Error).message}`)
      failed++
    }
  }
  return { passed, failed }
}

async function main(): Promise<void> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  console.log('=== Match-vibes test harness ===')
  console.log(`Function URL: ${FUNCTION_URL}\n`)

  const tests: NamedTest[] = [
    { name: '1. generic 3-vibe query',         fn: test1_genericQuery },
    { name: '2. determinism (tiebreaker)',     fn: test2_determinism },
    { name: '3. spice range filter',           fn: test3_spiceFilter },
    { name: '4. empty input → all weak',       fn: test4_emptyInput },
    { name: '5. out-of-range clamp',           fn: test5_outOfRangeClamp },
    { name: '6. invalid input → 400',          fn: test6_invalidInput },
    { name: '7. anonymous query is logged',    fn: test7_anonymousLogging },
    { name: '8. warm-mode forced via boost',   fn: () => test8_warmModeForced(supabase) },
  ]

  const { passed, failed } = await runTests(tests)

  console.log(`\n=== Results ===`)
  console.log(`Passed: ${passed}/${tests.length}`)
  if (failed > 0) {
    console.log(`Failed: ${failed}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('Fatal:', e instanceof Error ? e.message : e)
  process.exit(1)
})
