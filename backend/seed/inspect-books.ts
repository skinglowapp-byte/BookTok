import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
config({ path: resolve(ROOT, '.env.local') })

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

async function main() {
  const { data: books, error } = await supabase
    .from('books')
    .select('title, published_year, author_ids, language')
    .order('created_at', { ascending: false })
    .limit(50)

  if (error || !books) {
    console.error('Query failed:', error?.message)
    process.exit(1)
  }

  // Year distribution
  const buckets: Record<string, number> = {
    'pre-1990': 0, '1990s': 0, '2000s': 0, '2010s': 0, '2020s': 0, 'no_year': 0,
  }
  for (const b of books) {
    const y = b.published_year
    if (!y) buckets['no_year']++
    else if (y < 1990) buckets['pre-1990']++
    else if (y < 2000) buckets['1990s']++
    else if (y < 2010) buckets['2000s']++
    else if (y < 2020) buckets['2010s']++
    else buckets['2020s']++
  }

  console.log('=== Year distribution of last 50 books ===')
  Object.entries(buckets).forEach(([k, v]) => console.log(`  ${k.padEnd(10)} ${v}`))

  // Resolve author names
  const allAuthorIds = [...new Set(books.flatMap((b) => b.author_ids))]
  const { data: authors } = await supabase
    .from('authors')
    .select('id, name')
    .in('id', allAuthorIds)

  const nameById = new Map((authors ?? []).map((a) => [a.id, a.name]))

  console.log('\n=== Sample of 50 most recent books ===')
  books.forEach((b) => {
    const authorName = nameById.get(b.author_ids[0]) ?? '???'
    const yr = b.published_year ?? '????'
    console.log(`  [${yr}] ${b.title}  —  ${authorName}`)
  })
}

main().catch((e) => { console.error(e); process.exit(1) })
