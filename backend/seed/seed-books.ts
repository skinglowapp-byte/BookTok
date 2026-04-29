import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
config({ path: resolve(ROOT, '.env.local') })

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

// ─── CLI args ─────────────────────────────────────────────────────────────
// Usage: npm run seed:books -- --limit 50

const limitArgIdx = process.argv.indexOf('--limit')
const LIMIT: number = (() => {
  if (limitArgIdx === -1) return Infinity
  const val = parseInt(process.argv[limitArgIdx + 1], 10)
  if (isNaN(val) || val <= 0) {
    console.error('--limit must be a positive integer')
    process.exit(1)
  }
  return val
})()

if (LIMIT !== Infinity) {
  console.log(`Running with --limit ${LIMIT}\n`)
}

// ─── Open Library API shapes ──────────────────────────────────────────────

interface OLSearchDoc {
  key: string                      // '/works/OL12345W'
  title: string
  subtitle?: string
  author_name?: string[]
  author_key?: string[]            // '/authors/OL12345A'
  isbn?: string[]
  first_publish_year?: number
  cover_i?: number
  number_of_pages_median?: number
  publisher?: string[]
  subject?: string[]
  language?: string[]              // edition languages, e.g. ['eng', 'spa']
}

interface OLSearchResponse {
  numFound: number
  docs: OLSearchDoc[]
}

interface OLWork {
  key: string
  description?: string | { type: string; value: string }
  subjects?: string[]
  covers?: number[]
}

interface OLAuthorResponse {
  key: string
  name: string
  bio?: string | { type: string; value: string }
  photos?: number[]
}

// ─── Internal shapes ──────────────────────────────────────────────────────

interface BookCandidate {
  olWorkId: string
  title: string
  subtitle: string | null
  olAuthorKeys: string[]           // bare IDs: 'OL12345A'
  isbn13: string | null
  isbn10: string | null
  coverId: number | null
  pageCount: number | null
  publishedYear: number | null
  publisher: string | null
  description: string | null
  genreTags: string[]
  sourceSubject: string
}

interface AuthorRow {
  open_library_id: string
  name: string
  bio: string | null
  photo_url: string | null
}

interface BookRow {
  open_library_id: string
  isbn_13: string | null
  isbn_10: string | null
  title: string
  subtitle: string | null
  author_ids: string[]
  description: string | null
  cover_url: string | null
  page_count: number | null
  published_year: number | null
  language: string
  format: string
  publisher: string | null
  genre_tags: string[]
}

interface SkipReasons {
  duped: number              // in-memory dedup hit (work id or isbn13)
  noMetadata: number         // missing title / key / author_key
  language: number           // doc.language doesn't include 'eng'
  yearFloor: number          // first_publish_year < HARD_MIN_YEAR
  classicsSubjects: string[] // labels of subjects dropped by classics fallback
}

// ─── Config ───────────────────────────────────────────────────────────────

const OL_BASE    = 'https://openlibrary.org'
const COVERS_BASE = 'https://covers.openlibrary.org'
const CONCURRENCY = 5
const POLITENESS_MS = 200    // delay after every concurrent API call
const IN_BATCH_SIZE = 200    // max IDs per .in() query to stay under URL limits

const MIN_PUBLISH_YEAR = 2010  // URL-level filter; subject.minYear overrides per entry
const HARD_MIN_YEAR   = 1990  // client-side absolute floor regardless of query

interface SubjectConfig {
  label: string
  subject?: string   // OL taxonomy slug  → subject= param
  q?: string         // free-text terms   → appended to q= param
  target: number
  minYear?: number   // defaults to MIN_PUBLISH_YEAR
}

const SUBJECTS: SubjectConfig[] = [
  // Romantasy / Fantasy Romance
  { label: 'fantasy_romance',        subject: 'fantasy_romance',                              target: 150 },
  { label: 'romantasy',              q: 'romantasy',                                          target: 100 },
  { label: 'fae',                    q: 'fae romance',                                        target:  80 },
  { label: 'vampires',               subject: 'vampires',                                     target:  80 },
  { label: 'shifters',               q: 'shifter romance werewolf romance',                   target:  60 },
  // Contemporary Romance
  { label: 'contemporary_romance',   subject: 'contemporary_romance',                         target: 150 },
  { label: 'billionaire_romance',    q: 'billionaire romance',                                target:  60 },
  { label: 'rom_com',                q: 'romantic comedy',                                    target:  60 },
  // Young Adult
  { label: 'ya_fantasy',             subject: 'young_adult_fiction', q: 'fantasy',            target: 100 },
  { label: 'ya_romance',             subject: 'young_adult_fiction', q: 'romance',            target:  80 },
  // Dark / Spicy
  { label: 'dark_romance',           q: 'dark romance',                                       target: 100 },
  { label: 'mafia_romance',          q: 'mafia romance',                                      target:  60 },
  // Thriller
  { label: 'psychological_thriller', q: 'psychological thriller',                             target:  80 },
  { label: 'domestic_thriller',      q: 'domestic thriller',                                  target:  60 },
  // Literary / Contemporary Fiction
  { label: 'literary_fiction',       subject: 'literary_fiction',                             target:  80 },
]

// Builds the OL search URL. Year filter is injected into q= so it reaches Solr's
// range parser. Brackets are sent unencoded — OL's server decodes before Solr.
function buildSearchUrl(subj: SubjectConfig, page: number): string {
  const minYear = subj.minYear ?? MIN_PUBLISH_YEAR
  const qParts  = [subj.q, `first_publish_year:[${minYear} TO *]`].filter(Boolean)
  const parts: string[] = []
  if (subj.subject) parts.push(`subject=${subj.subject}`)
  parts.push(
    `q=${qParts.join(' ')}`,
    `language=eng`,
    `sort=readinglog`,
    `limit=100`,
    `page=${page}`,
    `fields=key,title,subtitle,author_name,author_key,isbn,first_publish_year,` +
    `cover_i,number_of_pages_median,publisher,subject,language`,
  )
  return `${OL_BASE}/search.json?${parts.join('&')}`
}

// ─── Utilities ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function fetchJSON<T>(url: string, retries = 3): Promise<T | null> {
  const delays = [500, 2000, 8000]
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'BookTok-seed/1.0' },
      })
      if (res.status === 404) return null
      if (res.ok) return res.json() as Promise<T>
      if (attempt < retries && [429, 500, 503].includes(res.status)) {
        await sleep(delays[attempt] + Math.random() * 300)
        continue
      }
      console.error(`  [http ${res.status}] ${url}`)
      return null
    } catch (e) {
      if (attempt === retries) {
        console.error(`  [network] ${url}: ${(e as Error).message}`)
        return null
      }
      await sleep(delays[attempt])
    }
  }
  return null
}

// Worker-pool concurrency: up to `limit` tasks run at once.
// `next` is read+incremented synchronously (no await in between), so no races.
async function runConcurrent<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0
  async function worker() {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

// Chunk an .in() filter to stay under the ~8 KB URL limit PostgREST enforces.
async function queryByOlIds<T>(
  supabase: SupabaseClient,
  table: string,
  ids: string[],
  selectCols: string
): Promise<T[]> {
  const results: T[] = []
  for (let i = 0; i < ids.length; i += IN_BATCH_SIZE) {
    const chunk = ids.slice(i, i + IN_BATCH_SIZE)
    const { data, error } = await supabase.from(table).select(selectCols).in('open_library_id', chunk)
    if (error) throw new Error(`queryByOlIds(${table}): ${error.message}`)
    if (data) results.push(...(data as T[]))
  }
  return results
}

function olId(key: string): string {
  return key.split('/').pop()!
}

function extractIsbn13(isbns: string[]): string | null {
  return isbns.find((s) => s.length === 13 && /^97[89]/.test(s)) ?? null
}

function extractIsbn10(isbns: string[]): string | null {
  return isbns.find((s) => s.length === 10 && /^\d{9}[\dXx]$/.test(s)) ?? null
}

function normalizeText(val?: string | { value: string }): string | null {
  if (!val) return null
  const text = typeof val === 'string' ? val : val.value
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : null
}

const coverUrl       = (coverId: number)    => `${COVERS_BASE}/b/id/${coverId}-L.jpg`
const authorPhotoUrl = (olAuthorId: string) => `${COVERS_BASE}/a/olid/${olAuthorId}-L.jpg`

// ─── Phase 1: Collect candidates via Search API ───────────────────────────

async function collectCandidates(): Promise<{
  candidates: BookCandidate[]
  authorMeta: Map<string, string>  // olAuthorId → display name (from search)
  skipReasons: SkipReasons
}> {
  const perSubject = LIMIT !== Infinity ? Math.ceil(LIMIT / SUBJECTS.length) : null
  console.log(`[Phase 1] Collecting candidates${LIMIT !== Infinity ? ` (limit: ${LIMIT}, ~${perSubject} per subject)` : ''}\n`)

  const seenWorkIds = new Set<string>()
  const seenIsbn13s = new Set<string>()
  const candidates: BookCandidate[] = []
  const authorMeta = new Map<string, string>()
  const skipReasons: SkipReasons = {
    duped: 0, noMetadata: 0, language: 0, yearFloor: 0, classicsSubjects: [],
  }

  outer: for (const subject of SUBJECTS) {
    const target = perSubject ?? subject.target
    let collected = 0
    let duped = 0
    let page = 1
    const pagesNeeded = Math.ceil(target / 100)

    while (collected < target && page <= pagesNeeded) {
      const url  = buildSearchUrl(subject, page)
      const data = await fetchJSON<OLSearchResponse>(url)
      if (!data?.docs?.length) break

      // Classics fallback: if page 1 has a median publish year before 2000 the
      // subject is returning old canon rather than modern BookTok books — drop it.
      if (page === 1) {
        const years  = data.docs.map(d => d.first_publish_year).filter((y): y is number => !!y)
        const sorted = [...years].sort((a, b) => a - b)
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0
        if (median > 0 && median < 2000) {
          console.warn(`  [skip] ${subject.label}: median year ${median} — mostly classics, dropping subject`)
          skipReasons.classicsSubjects.push(subject.label)
          break
        }
      }

      for (const doc of data.docs) {
        if (candidates.length >= LIMIT) break outer   // safety cap for --limit
        if (collected >= target) break
        // Hard language filter: skip works with no English edition in their language list
        if (doc.language && !doc.language.includes('eng')) { skipReasons.language++; continue }
        // Hard year floor: skip anything published before 1990 (client-side safety net)
        if (doc.first_publish_year && doc.first_publish_year < HARD_MIN_YEAR) { skipReasons.yearFloor++; continue }
        // Minimum metadata: title + OL work key + at least one author
        if (!doc.title || !doc.key || !doc.author_key?.length) { skipReasons.noMetadata++; continue }

        const workId = olId(doc.key)
        const isbn13 = extractIsbn13(doc.isbn ?? [])

        if (seenWorkIds.has(workId) || (isbn13 && seenIsbn13s.has(isbn13))) {
          duped++
          skipReasons.duped++
          continue
        }
        seenWorkIds.add(workId)
        if (isbn13) seenIsbn13s.add(isbn13)

        doc.author_key.forEach((key, i) => {
          const id = olId(key)
          if (!authorMeta.has(id)) authorMeta.set(id, doc.author_name?.[i] ?? 'Unknown')
        })

        candidates.push({
          olWorkId:      workId,
          title:         doc.title,
          subtitle:      doc.subtitle ?? null,
          olAuthorKeys:  doc.author_key.map(olId),
          isbn13,
          isbn10:        extractIsbn10(doc.isbn ?? []),
          coverId:       (doc.cover_i && doc.cover_i > 0) ? doc.cover_i : null,
          pageCount:     (doc.number_of_pages_median && doc.number_of_pages_median > 0)
                           ? doc.number_of_pages_median : null,
          publishedYear: doc.first_publish_year ?? null,
          publisher:     doc.publisher?.[0] ?? null,
          description:   null,
          genreTags:     (doc.subject ?? []).slice(0, 20),
          sourceSubject: subject.label,
        })
        collected++
      }

      page++
      if (page <= pagesNeeded) await sleep(POLITENESS_MS)
    }

    console.log(`  ${subject.label.padEnd(22)} ${collected} collected, ${duped} duped`)
    if (candidates.length >= LIMIT) break
  }

  console.log(`\n  Total: ${candidates.length} candidates, ${authorMeta.size} unique authors\n`)
  return { candidates, authorMeta, skipReasons }
}

// ─── Phase 2: Enrich candidates with descriptions from Works API ──────────

async function enrichCandidates(candidates: BookCandidate[]): Promise<void> {
  console.log(`[Phase 2] Enriching ${candidates.length} works\n`)

  let done = 0
  let withDescription = 0

  const tasks = candidates.map((c) => async () => {
    const work = await fetchJSON<OLWork>(`${OL_BASE}/works/${c.olWorkId}.json`)
    if (work) {
      const desc = normalizeText(work.description)
      if (desc) { c.description = desc; withDescription++ }
      // Prefer richer subject list from work detail over shallow search result
      if (work.subjects && work.subjects.length > c.genreTags.length) {
        c.genreTags = work.subjects.slice(0, 20)
      }
      // Fall back to work covers if search gave us none
      if (!c.coverId && work.covers?.[0] && work.covers[0] > 0) {
        c.coverId = work.covers[0]
      }
    }
    await sleep(POLITENESS_MS)  // 200ms cooldown after every Works API call
    done++
    if (done % 100 === 0) console.log(`  ${done}/${candidates.length} enriched...`)
  })

  await runConcurrent(tasks, CONCURRENCY)

  console.log(
    `\n  Done — ${withDescription} with description, ` +
    `${candidates.length - withDescription} without\n`
  )
}

// ─── Phase 3: Upsert authors + build olAuthorId → UUID map ───────────────

async function upsertAuthors(
  supabase: SupabaseClient,
  authorMeta: Map<string, string>
): Promise<Map<string, string>> {
  const allIds = Array.from(authorMeta.keys())
  console.log(`[Phase 3] Upserting ${allIds.length} authors\n`)

  if (allIds.length === 0) return new Map()

  // Find which are already in DB (chunked to stay under URL limits)
  const existing = await queryByOlIds<{ open_library_id: string }>(
    supabase, 'authors', allIds, 'open_library_id'
  )
  const existingSet = new Set(existing.map((r) => r.open_library_id))
  const newIds = allIds.filter((id) => !existingSet.has(id))
  console.log(`  ${existingSet.size} already in DB, fetching ${newIds.length} new`)

  // Fetch author details for new authors concurrently, with politeness delay
  let fetched = 0
  const authorRows: AuthorRow[] = []

  const fetchTasks = newIds.map((olAuthorId) => async () => {
    const data = await fetchJSON<OLAuthorResponse>(`${OL_BASE}/authors/${olAuthorId}.json`)
    const hasPhoto = (data?.photos ?? []).some((p) => p > 0)
    authorRows.push({
      open_library_id: olAuthorId,
      name:      data?.name ?? authorMeta.get(olAuthorId) ?? 'Unknown',
      bio:       data ? normalizeText(data.bio) : null,
      photo_url: hasPhoto ? authorPhotoUrl(olAuthorId) : null,
    })
    await sleep(POLITENESS_MS)  // 200ms cooldown after every Authors API call
    fetched++
    if (fetched % 50 === 0) console.log(`  fetched ${fetched}/${newIds.length} author details...`)
  })

  await runConcurrent(fetchTasks, CONCURRENCY)

  // Upsert new authors per-row to match seed-vocabulary.ts pattern and log individual failures
  let failed = 0
  for (const row of authorRows) {
    const { error } = await supabase.from('authors').upsert(row, { onConflict: 'open_library_id' })
    if (error) {
      console.error(`  [skip] author ${row.open_library_id} — ${error.message}`)
      failed++
    }
  }

  console.log(
    `\n  Upserted ${authorRows.length - failed} new authors` +
    (failed > 0 ? `, ${failed} failed` : '') + '\n'
  )

  // Single DB round-trip to build olAuthorId → supabase UUID map for ALL authors seen this run
  const uuidRows = await queryByOlIds<{ id: string; open_library_id: string }>(
    supabase, 'authors', allIds, 'id, open_library_id'
  )

  const authorMap = new Map<string, string>()
  for (const row of uuidRows) {
    authorMap.set(row.open_library_id, row.id)
  }

  console.log(`  Author map built: ${authorMap.size} entries\n`)
  return authorMap
}

// ─── Phase 4: Upsert books using in-memory author map ────────────────────

async function upsertBooks(
  supabase: SupabaseClient,
  candidates: BookCandidate[],
  authorMap: Map<string, string>   // olAuthorId → supabase UUID — no DB calls made here
): Promise<{
  bySubject: Record<string, number>
  noAuthorsSkipped: number
  dbErrors: number
}> {
  console.log(`[Phase 4] Upserting ${candidates.length} books\n`)

  let succeeded = 0
  let skipped = 0
  let failed = 0
  const bySubject: Record<string, number> = {}

  for (const c of candidates) {
    // Resolve OL author keys → supabase UUIDs using the in-memory map only
    const authorIds = c.olAuthorKeys
      .map((key) => authorMap.get(key))
      .filter((id): id is string => id !== undefined)

    if (authorIds.length === 0) {
      console.error(`  [skip] ${c.olWorkId} "${c.title}" — no resolvable authors`)
      skipped++
      continue
    }

    const row: BookRow = {
      open_library_id: c.olWorkId,
      isbn_13:         c.isbn13,
      isbn_10:         c.isbn10,
      title:           c.title,
      subtitle:        c.subtitle,
      author_ids:      authorIds,
      description:     c.description,
      cover_url:       c.coverId ? coverUrl(c.coverId) : null,
      page_count:      c.pageCount,
      published_year:  c.publishedYear,
      language:        'en',
      format:          'unknown',
      publisher:       c.publisher,
      genre_tags:      c.genreTags,
    }

    const { error } = await supabase.from('books').upsert(row, { onConflict: 'open_library_id' })
    if (error) {
      console.error(`  [skip] ${c.olWorkId} "${c.title}" — ${error.message}`)
      failed++
    } else {
      succeeded++
      bySubject[c.sourceSubject] = (bySubject[c.sourceSubject] ?? 0) + 1
    }
  }

  console.log(
    `\n  ${succeeded} upserted, ${skipped} skipped (no authors), ${failed} DB errors\n`
  )

  return { bySubject, noAuthorsSkipped: skipped, dbErrors: failed }
}

// ─── Verification + summary ───────────────────────────────────────────────

async function printSummary(
  supabase: SupabaseClient,
  args: {
    bySubject: Record<string, number>
    skipReasons: SkipReasons
    noAuthorsSkipped: number
    dbErrors: number
  },
): Promise<void> {
  const { bySubject, skipReasons, noAuthorsSkipped, dbErrors } = args

  // Totals + coverage
  const [books, authors, withDesc, withCover] = await Promise.all([
    supabase.from('books').select('*',   { count: 'exact', head: true }),
    supabase.from('authors').select('*', { count: 'exact', head: true }),
    supabase.from('books').select('*',   { count: 'exact', head: true }).not('description', 'is', null),
    supabase.from('books').select('*',   { count: 'exact', head: true }).not('cover_url',   'is', null),
  ])
  const total = books.count ?? 0
  const pct   = (n: number | null) =>
    total > 0 ? ` (${Math.round(((n ?? 0) / total) * 100)}%)` : ''

  // Year buckets via parallel head:true counts (no rows transferred)
  const [pre1990, y1990s, y2000s, y2010s, y2020s, noYear] = await Promise.all([
    supabase.from('books').select('*', { count: 'exact', head: true }).lt('published_year', 1990),
    supabase.from('books').select('*', { count: 'exact', head: true }).gte('published_year', 1990).lt('published_year', 2000),
    supabase.from('books').select('*', { count: 'exact', head: true }).gte('published_year', 2000).lt('published_year', 2010),
    supabase.from('books').select('*', { count: 'exact', head: true }).gte('published_year', 2010).lt('published_year', 2020),
    supabase.from('books').select('*', { count: 'exact', head: true }).gte('published_year', 2020),
    supabase.from('books').select('*', { count: 'exact', head: true }).is('published_year', null),
  ])

  // Top 20 authors by book count — fetch all author_ids and aggregate client-side
  const { data: bookRows } = await supabase.from('books').select('author_ids').limit(5000)
  const counts = new Map<string, number>()
  for (const b of bookRows ?? []) {
    for (const aid of (b as { author_ids: string[] }).author_ids ?? []) {
      counts.set(aid, (counts.get(aid) ?? 0) + 1)
    }
  }
  const top20Entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20)
  const top20Ids     = top20Entries.map(([id]) => id)

  let nameById = new Map<string, string>()
  if (top20Ids.length > 0) {
    const { data: authorRows } = await supabase
      .from('authors')
      .select('id, name')
      .in('id', top20Ids)
    nameById = new Map((authorRows ?? []).map((a: { id: string; name: string }) => [a.id, a.name]))
  }

  // ── Print ──
  console.log('\n=== Final Summary ===\n')
  console.log(`Total books:      ${total}`)
  console.log(`Total authors:    ${authors.count ?? 0}`)
  console.log(`With description: ${withDesc.count ?? 0}${pct(withDesc.count)}`)
  console.log(`With cover:       ${withCover.count ?? 0}${pct(withCover.count)}`)

  console.log('\nYear distribution:')
  console.log(`  2020+        ${y2020s.count ?? 0}${pct(y2020s.count)}`)
  console.log(`  2010-2019    ${y2010s.count ?? 0}${pct(y2010s.count)}`)
  console.log(`  2000-2009    ${y2000s.count ?? 0}${pct(y2000s.count)}`)
  console.log(`  1990-1999    ${y1990s.count ?? 0}${pct(y1990s.count)}`)
  console.log(`  pre-1990     ${pre1990.count ?? 0}${pct(pre1990.count)}`)
  console.log(`  no year      ${noYear.count ?? 0}${pct(noYear.count)}`)

  console.log('\nTop 20 authors by book count:')
  if (top20Entries.length === 0) {
    console.log('  (no books in DB)')
  } else {
    top20Entries.forEach(([id, count], i) => {
      const name = nameById.get(id) ?? '(unknown)'
      console.log(`  ${String(i + 1).padStart(2)}. ${name.padEnd(35)} ${count}`)
    })
  }

  console.log('\nSubject distribution (this run):')
  Object.entries(bySubject)
    .sort((a, b) => b[1] - a[1])
    .forEach(([sub, n]) => console.log(`  ${sub.padEnd(24)} ${n}`))

  console.log('\nSkip counts:')
  console.log(`  Duped (in-memory):         ${skipReasons.duped}`)
  console.log(`  Failed metadata check:     ${skipReasons.noMetadata}`)
  console.log(`  Language filter:           ${skipReasons.language}`)
  console.log(`  Year floor (<${HARD_MIN_YEAR}):       ${skipReasons.yearFloor}`)
  console.log(`  No resolvable authors:     ${noAuthorsSkipped}`)
  console.log(`  DB upsert errors:          ${dbErrors}`)
  console.log(
    `  Subjects dropped:          ${skipReasons.classicsSubjects.length}` +
    (skipReasons.classicsSubjects.length > 0 ? ` (${skipReasons.classicsSubjects.join(', ')})` : ''),
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  const { candidates, authorMeta, skipReasons } = await collectCandidates()
  await enrichCandidates(candidates)
  const authorMap = await upsertAuthors(supabase, authorMeta)
  const { bySubject, noAuthorsSkipped, dbErrors } = await upsertBooks(supabase, candidates, authorMap)
  await printSummary(supabase, { bySubject, skipReasons, noAuthorsSkipped, dbErrors })
}

main().catch((e) => {
  console.error('Fatal error:', e)
  process.exit(1)
})
