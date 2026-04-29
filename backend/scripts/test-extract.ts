import Anthropic from '@anthropic-ai/sdk'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
config({ path: resolve(ROOT, '.env.local') })

const SUPABASE_URL              = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC_API_KEY         = process.env.ANTHROPIC_API_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or ANTHROPIC_API_KEY in .env.local')
  process.exit(1)
}

const bookId = process.argv[2]
if (!bookId) {
  console.error('Usage: npm run test:extract -- <book_id>')
  process.exit(1)
}

const MODEL      = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 1024

// ─── Types ────────────────────────────────────────────────────────────────

interface Book {
  id: string
  title: string
  subtitle: string | null
  description: string | null
  genre_tags: string[] | null
  author_ids: string[]
  open_library_id: string | null
  published_year: number | null
}

interface Author {
  id: string
  name: string
}

interface VibeRow {
  id: string
  category: string
}

interface ExtractionResult {
  moods?: string[]
  tropes?: string[]
  aesthetics?: string[]
  pace?: string | null
  spice_level?: number
  themes?: string[]
  content_warnings?: { tag: string; severity: string }[]
  confidence?: number
  reasoning?: string
}

interface ValidationIssue {
  field: string
  tag: string
  reason: string
}

interface ValidIds {
  byCategory: Record<string, Set<string>>
  all: Set<string>
}

// ─── Prompt template ──────────────────────────────────────────────────────

const PROMPT_TEMPLATE = `You are a book vibe tagger for a BookTok-style reading app. Your job is to read
metadata about a book and output structured vibe tags using ONLY the provided
vocabulary.

Critical rules:
1. ONLY use IDs from the vocabulary. Never invent tags. If you can't find a fitting
   tag in the vocabulary, omit it — don't substitute.
2. Be discriminating. "Cozy," "dark," and "slow burn" are massively overused. Only
   apply them when they are the dominant trait, not a secondary one.
3. Pick the MOST DISTINCTIVE tags, not the safest. A book is more useful tagged
   "morally gray" than "fiction."
4. If you genuinely cannot determine a field, use null or empty array. Lower
   confidence over invented data.
5. Spice levels are explicit and specific:
   - 0 = no romance content at all
   - 1 = closed door / clean (kissing only or fade-to-black before any heat)
   - 2 = on-page romantic but tame (no explicit sex)
   - 3 = on-page sex, tasteful and infrequent
   - 4 = explicit and frequent (most adult romance fits here)
   - 5 = filthy / smut (the book is primarily about sex; multiple kinks; very explicit)
   spice_level is always an integer 0-5. Default to 0 if there is no romance content. Never null.
6. Content warnings only when you are confident from the source material. Severity:
   - graphic = depicted on-page in detail
   - moderate = depicted but not graphic
   - mentioned = referenced but not depicted
   Valid content_warning IDs are exactly: cw_sa, cw_self_harm, cw_suicide, cw_eating_disorder, cw_child_abuse, cw_pet_death, cw_infidelity, cw_pregnancy_loss, cw_gore. If a warning concept doesn't match one of these (e.g., violence, drug use, abuse not falling under listed categories), omit it. Do not invent new IDs.
7. Sparse input handling: If description is empty or under 50 characters, do not infer vibes from your training-data knowledge of the author or echo broad genre tags. Lower confidence to 0.4 or below. Use only what you can derive from title and explicit genre tags. Better to leave fields empty than to guess from author reputation or pattern-match from genre tags.

Book metadata:
Title: {title}
Author(s): {authors}
Description: {description}
Open Library genre tags: {genre_tags}

Vocabulary (you may ONLY use IDs from this list):
{vocabulary_json}

Category placement:
- moods = the emotional register the reader feels
- tropes = recognized structural patterns and dynamics readers seek by name
Trope IDs with emotional connotations like found_family and tension are still tropes (structural patterns), not moods. Place each ID only in the field matching its category in the vocabulary.

Output JSON with this exact schema:
{
  "moods": [array of mood IDs, max 5],
  "tropes": [array of trope IDs, max 8],
  "aesthetics": [array of aesthetic IDs, max 3],
  "pace": "pace_slow" | "pace_medium" | "pace_fast" | "unputdownable" | "quiet" | "epic" | "vignette" | "single_sitting" | "chunky_tome" | "novella" | null,
  "spice_level": integer 0-5,
  "themes": [array of theme IDs, max 6],
  "content_warnings": [
    { "tag": "cw_id", "severity": "graphic" | "moderate" | "mentioned" }
  ],
  "confidence": 0.0-1.0,
  "reasoning": "one sentence explaining the dominant vibe"
}

Confidence guidance:
- 0.8+ when description is rich and you're sure about most fields
- 0.5-0.7 when description is sparse but title/genre tags give signal
- below 0.5 when you're guessing — flag this honestly

Return ONLY the JSON. No preamble, no markdown fences, no explanation outside the
reasoning field.`

// ─── Data fetching ────────────────────────────────────────────────────────

async function fetchBook(supabase: SupabaseClient, id: string): Promise<{ book: Book; authors: Author[] }> {
  const { data: book, error } = await supabase
    .from('books')
    .select('id, title, subtitle, description, genre_tags, author_ids, open_library_id, published_year')
    .eq('id', id)
    .single<Book>()

  if (error || !book) {
    console.error(`Book not found: ${id}`)
    if (error) console.error(`  ${error.message}`)
    process.exit(1)
  }

  const { data: authors, error: authorsErr } = await supabase
    .from('authors')
    .select('id, name')
    .in('id', book.author_ids)

  if (authorsErr) {
    console.error(`Failed to fetch authors: ${authorsErr.message}`)
    process.exit(1)
  }

  return { book, authors: (authors ?? []) as Author[] }
}

async function fetchValidIds(supabase: SupabaseClient): Promise<ValidIds> {
  const { data: vibes, error } = await supabase.from('vibes').select('id, category')
  if (error || !vibes) {
    console.error(`Failed to fetch vibes table: ${error?.message}`)
    process.exit(1)
  }

  const byCategory: Record<string, Set<string>> = {}
  const all = new Set<string>()
  for (const v of vibes as VibeRow[]) {
    if (!byCategory[v.category]) byCategory[v.category] = new Set()
    byCategory[v.category].add(v.id)
    all.add(v.id)
  }
  return { byCategory, all }
}

// ─── Prompt building + JSON extraction ────────────────────────────────────

function buildPrompt(book: Book, authors: Author[], vocabularyJson: string): string {
  // Use function replacements so '$' chars in descriptions/JSON aren't interpreted
  // as regex backreferences ($&, $1, etc).
  return PROMPT_TEMPLATE
    .replace('{title}',           () => book.title + (book.subtitle ? `: ${book.subtitle}` : ''))
    .replace('{authors}',         () => authors.map((a) => a.name).join(', ') || '(unknown)')
    .replace('{description}',     () => book.description ?? '(no description available)')
    .replace('{genre_tags}',      () => (book.genre_tags ?? []).join(', ') || '(none)')
    .replace('{vocabulary_json}', () => vocabularyJson)
}

// Defensive: try direct parse, then fenced, then scan for first { ... last }
function extractJson(text: string): unknown {
  try { return JSON.parse(text) } catch {}

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) {
    try { return JSON.parse(fence[1]) } catch {}
  }

  const start = text.indexOf('{')
  const end   = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch {}
  }
  return null
}

// ─── Validation ───────────────────────────────────────────────────────────

function validate(result: ExtractionResult, valid: ValidIds): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const checkInCategory = (field: string, tag: string, expected: string) => {
    if (!valid.all.has(tag)) {
      issues.push({ field, tag, reason: 'unknown ID (not in vibes table)' })
    } else if (!valid.byCategory[expected]?.has(tag)) {
      issues.push({ field, tag, reason: `wrong category (expected ${expected})` })
    }
  }

  for (const m of result.moods      ?? []) checkInCategory('moods',      m, 'mood')
  for (const t of result.tropes     ?? []) checkInCategory('tropes',     t, 'trope')
  for (const a of result.aesthetics ?? []) checkInCategory('aesthetics', a, 'aesthetic')
  for (const t of result.themes     ?? []) checkInCategory('themes',     t, 'theme')

  if (result.pace !== null && result.pace !== undefined) {
    if (!valid.byCategory['pace']?.has(result.pace)) {
      issues.push({ field: 'pace', tag: result.pace, reason: 'not a valid pace ID' })
    }
  }

  for (const cw of result.content_warnings ?? []) {
    if (!valid.byCategory['content_warning']?.has(cw.tag)) {
      issues.push({ field: 'content_warnings', tag: cw.tag, reason: 'not a valid content_warning ID' })
    }
    if (!['graphic', 'moderate', 'mentioned'].includes(cw.severity)) {
      issues.push({ field: 'content_warnings', tag: `${cw.tag}/${cw.severity}`, reason: 'invalid severity value' })
    }
  }

  if (result.spice_level !== undefined) {
    const s = result.spice_level
    if (!Number.isInteger(s) || s < 0 || s > 5) {
      issues.push({ field: 'spice_level', tag: String(s), reason: 'must be integer 0-5' })
    }
  } else {
    issues.push({ field: 'spice_level', tag: 'undefined', reason: 'required field missing' })
  }

  if (result.confidence !== undefined) {
    const c = result.confidence
    if (typeof c !== 'number' || c < 0 || c > 1) {
      issues.push({ field: 'confidence', tag: String(c), reason: 'must be number 0-1' })
    }
  } else {
    issues.push({ field: 'confidence', tag: 'undefined', reason: 'required field missing' })
  }

  return issues
}

// ─── Pretty print ─────────────────────────────────────────────────────────

function printBook(book: Book, authors: Author[]): void {
  const desc = book.description ?? '(none)'
  const truncDesc = desc.length > 280 ? desc.slice(0, 280) + '...' : desc
  const genres   = (book.genre_tags ?? []).slice(0, 6).join(', ') || '(none)'

  console.log('=== Book ===')
  console.log(`Title:        ${book.title}${book.subtitle ? ` — ${book.subtitle}` : ''}`)
  console.log(`Author(s):    ${authors.map((a) => a.name).join(', ') || '(unknown)'}`)
  console.log(`Year:         ${book.published_year ?? 'unknown'}`)
  console.log(`Genre tags:   ${genres}${(book.genre_tags?.length ?? 0) > 6 ? ` (+${(book.genre_tags!.length - 6)} more)` : ''}`)
  console.log(`Description:  ${truncDesc}`)
  console.log()
}

function printResult(parsed: unknown, issues: ValidationIssue[]): void {
  console.log('=== Extraction Result ===')
  console.log(JSON.stringify(parsed, null, 2))
  console.log()

  console.log('=== Validation ===')
  if (issues.length === 0) {
    console.log('All tags valid against vibes table.')
  } else {
    console.log(`${issues.length} issue(s):`)
    for (const i of issues) {
      console.log(`  [${i.field}] "${i.tag}" — ${i.reason}`)
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const vocabularyPath = resolve(ROOT, 'docs', 'vibe-vocabulary.json')
  const vocabularyJson = readFileSync(vocabularyPath, 'utf-8')

  const supabase  = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY! })

  const [{ book, authors }, validIds] = await Promise.all([
    fetchBook(supabase, bookId),
    fetchValidIds(supabase),
  ])

  printBook(book, authors)

  const prompt = buildPrompt(book, authors, vocabularyJson)

  console.log(`Calling ${MODEL}...`)
  const t0 = Date.now()
  const response = await anthropic.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    messages:   [{ role: 'user', content: prompt }],
  })
  const elapsed = Date.now() - t0

  const text = response.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')

  console.log(`Response in ${elapsed}ms — ${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens\n`)

  const parsed = extractJson(text)
  if (!parsed) {
    console.error('Failed to parse JSON. Raw response:')
    console.error(text)
    process.exit(1)
  }

  const issues = validate(parsed as ExtractionResult, validIds)
  printResult(parsed, issues)
}

main().catch((e) => {
  console.error('Fatal:', e instanceof Error ? e.message : e)
  process.exit(1)
})
