import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
config({ path: resolve(ROOT, '.env.local') })

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

type VibeCategory =
  | 'mood'
  | 'trope'
  | 'aesthetic'
  | 'pace'
  | 'spice'
  | 'theme'
  | 'content_warning'

interface Vibe {
  id: string
  display: string
  category: VibeCategory
  value?: number
  aliases?: string[]
  related?: string[]
  popularity?: number | null
}

interface Vocabulary {
  version: string
  updated_at: string
  description: string
  categories: Record<VibeCategory, string>
  vibes: Vibe[]
}

interface VibeRow {
  id: string
  display: string
  category: VibeCategory
  spice_value: number | null
  aliases: string[]
  related: string[]
  popularity: number | null
}

function toRow(v: Vibe): VibeRow {
  return {
    id: v.id,
    display: v.display,
    category: v.category,
    spice_value: v.category === 'spice' ? v.value ?? null : null,
    aliases: v.aliases ?? [],
    related: v.related ?? [],
    popularity: v.popularity ?? null,
  }
}

async function upsertOne(supabase: SupabaseClient, row: VibeRow): Promise<boolean> {
  const { error } = await supabase.from('vibes').upsert(row, { onConflict: 'id' })
  if (error) {
    console.error(
      `  [skip] ${row.id} (${row.category}) — ${error.message}`,
    )
    return false
  }
  return true
}

async function main() {
  const vocabularyPath = resolve(ROOT, 'docs', 'vibe-vocabulary.json')
  const vocabulary: Vocabulary = JSON.parse(readFileSync(vocabularyPath, 'utf-8'))
  const rows = vocabulary.vibes.map(toRow)

  console.log(`Loading ${rows.length} vibes from ${vocabularyPath}`)
  console.log(`Vocabulary version: ${vocabulary.version} (updated ${vocabulary.updated_at})\n`)

  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })

  let succeeded = 0
  let failed = 0
  for (const row of rows) {
    const ok = await upsertOne(supabase, row)
    if (ok) succeeded++
    else failed++
  }

  console.log(`\nUpsert complete: ${succeeded} succeeded, ${failed} failed\n`)

  const { data: dbRows, error: queryError } = await supabase
    .from('vibes')
    .select('id, display, category, spice_value, popularity')
    .order('category', { ascending: true })
    .order('id', { ascending: true })

  if (queryError) {
    console.error('Verification query failed:', queryError.message)
    process.exit(1)
  }

  if (!dbRows) {
    console.error('Verification query returned no rows')
    process.exit(1)
  }

  type DbRow = (typeof dbRows)[number]
  const byCategory: Record<string, DbRow[]> = {}
  for (const r of dbRows) {
    ;(byCategory[r.category] ??= []).push(r)
  }

  console.log('=== Verification ===')
  console.log(`Total vibes in database: ${dbRows.length}\n`)

  console.log('Count by category:')
  Object.entries(byCategory)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([cat, items]) => {
      console.log(`  ${cat.padEnd(18)} ${items.length}`)
    })

  console.log('\nFirst 3 vibes per category:')
  Object.entries(byCategory)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([cat, items]) => {
      console.log(`  [${cat}]`)
      items.slice(0, 3).forEach((v) => {
        const extras: string[] = []
        if (v.spice_value !== null) extras.push(`spice=${v.spice_value}`)
        if (v.popularity !== null) extras.push(`pop=${v.popularity}`)
        const suffix = extras.length ? `  (${extras.join(', ')})` : ''
        console.log(`    - ${v.id} -> "${v.display}"${suffix}`)
      })
    })

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('Fatal error:', e)
  process.exit(1)
})
