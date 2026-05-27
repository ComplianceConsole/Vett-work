import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.38/deno-dom-wasm.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const AGENCY_KEYWORDS = [
  'recruitment', 'recruiting', 'staffing', 'talent solutions', 'executive search',
  'headhunt', 'labour hire', 'labor hire', 'manpower', 'hays', 'robert half',
  'hudson', 'randstad', 'adecco', 'michael page', 'people2people', 'chandler macleod',
  'skilled group', 'drake', 'korn ferry'
]

function isLikelyAgency(name: string): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  return AGENCY_KEYWORDS.some(kw => lower.includes(kw))
}

function cleanText(str: string): string {
  return (str || '')
    .replace(/<li[^>]*>/gi, ' • ')       // list items get bullet + space
    .replace(/<br[^>]*>/gi, ' ')          // line breaks become spaces
    .replace(/<\/p>/gi, ' ')             // paragraph ends become spaces
    .replace(/<[^>]+>/g, '')              // strip remaining HTML tags
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/([a-z])([A-Z])/g, '$1 $2') // fix camelCase joins e.g. systemsProvide
    .replace(/([a-z])([A-Z])/g, '$1 $2') // run twice to catch consecutive
    .replace(/([.,!?:;])([A-Za-z])/g, '$1 $2') // space after punctuation
    .replace(/•([A-Za-z])/g, '• $1')     // space after bullet
    .replace(/\s+/g, ' ')
    .trim()
}

function mapEmpType(badge: string): string {
  const t = (badge || '').toLowerCase()
  if (t.includes('part')) return 'parttime'
  if (t.includes('casual') || t.includes('temp')) return 'casual'
  if (t.includes('contract')) return 'contractor'
  return 'fulltime'
}

function mapWorkType(text: string): string {
  const t = (text || '').toLowerCase()
  if (t.includes('remote') || t.includes('work from home')) return 'remote'
  if (t.includes('hybrid')) return 'hybrid'
  return 'office'
}

function makeShortDesc(desc: string): string {
  const clean = cleanText(desc)
  // Take first 200 chars, cut at last complete word, add ellipsis
  if (clean.length <= 200) return clean
  const cut = clean.substring(0, 197)
  const lastSpace = cut.lastIndexOf(' ')
  return cut.substring(0, lastSpace) + '...'
}

async function fetchJobDetail(url: string, headers: Record<string, string>): Promise<string> {
  try {
    const res = await fetch(url, { headers })
    if (!res.ok) return ''
    const html = await res.text()
    const doc = new DOMParser().parseFromString(html, 'text/html')
    if (!doc) return ''
    // Try multiple selectors for job description
    const desc = doc.querySelector('.job-description, #job-description, [class*="description"], .content-body')
    return cleanText(desc?.textContent || '')
  } catch {
    return ''
  }
}

async function scrapeJoraPage(
  supabase: any,
  country: string, // 'au' or 'nz'
  category: string,
  joraCategory: string,
  page: number
): Promise<number> {
  const baseUrl = country === 'au' ? 'https://au.jora.com' : 'https://nz.jora.com'
  const url = `${baseUrl}/${joraCategory}-jobs?sp=facets&ca=${joraCategory.toLowerCase().replace(/-/g,'_')}&sort=date&p=${page}`

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-AU,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
  }

  const res = await fetch(url, { headers })
  if (!res.ok) {
    console.error(`Jora ${country}/${joraCategory} page ${page}: ${res.status}`)
    return 0
  }

  const html = await res.text()
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (!doc) return 0

  const cards = doc.querySelectorAll('.job-card.result.organic-job')
  let inserted = 0

  for (const card of Array.from(cards)) {
    try {
      const id = (card as Element).id?.replace('r_', '')
      if (!id) continue

      const title = cleanText((card.querySelector('.job-link') as Element)?.textContent || '')
      const company = cleanText((card.querySelector('.job-company') as Element)?.textContent || '')
      const location = cleanText((card.querySelector('.job-location') as Element)?.textContent || '')
      const snippet = cleanText((card.querySelector('.job-abstract') as Element)?.textContent || '')
      const empBadge = cleanText((card.querySelector('.badges') as Element)?.textContent || '')
      const dateText = cleanText((card.querySelector('.job-listed-date') as Element)?.textContent || '')
      const jobUrl = (card.querySelector('a.job-link') as HTMLAnchorElement)?.href || ''

      if (!title || !company) continue
      if (isLikelyAgency(company)) continue
      if (snippet.length < 50) continue

      // Skip jobs older than 7 days
      if (dateText.includes('30d') || dateText.includes('14d')) continue

      // Dedup
      const externalRef = `jora_${id}`
      const { data: existing } = await supabase.from('jobs').select('id').eq('external_reference', externalRef).single()
      if (existing) continue

      // Find or create employer
      let employerId: string | null = null
      const { data: existingEmp } = await supabase.from('employers').select('id').eq('company_name', company).eq('source', 'jora').single()
      if (existingEmp) {
        employerId = existingEmp.id
      } else {
        const { data: newEmp } = await supabase.from('employers').insert({
          company_name: company,
          source: 'jora',
          email: `jora_${id}@placeholder.vettwork.internal`,
          company_type: 'direct',
        }).select('id').single()
        if (newEmp) employerId = newEmp.id
      }
      if (!employerId) continue

      // Use snippet as description - no detail page fetch to save memory
      const fullDesc = snippet
      const workType = mapWorkType(empBadge + ' ' + snippet.substring(0, 200))

      await supabase.from('jobs').insert({
        employer_id: employerId,
        title,
        description: fullDesc,
        short_description: makeShortDesc(fullDesc || snippet),
        location,
        employment_type: mapEmpType(empBadge),
        work_type: workType,
        category,
        is_active: false,
        status: 'pending_review',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        external_reference: externalRef,
        application_url: jobUrl || null,
        source: 'jora',
      })
      inserted++
    } catch (err) {
      console.error('Error processing Jora job:', err)
    }
  }

  console.log(`Jora ${country}/${joraCategory} page ${page}: ${inserted} inserted from ${cards.length} cards`)
  return inserted
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SUPABASE_SERVICE_KEY = Deno.env.get('DB_SERVICE_ROLE_KEY')!
    const INGEST_API_KEY = Deno.env.get('JOB_INGEST_API_KEY')

    const apiKey = req.headers.get('x-api-key')
    if (apiKey !== INGEST_API_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Expire old jora jobs
    await supabase.from('jobs').update({ is_active: false })
      .eq('source', 'jora')
      .lt('expires_at', new Date().toISOString())

    // White collar categories, AU + NZ, 3 pages each
    const runs = [
      { country: 'au', category: 'technology',      joraCategory: 'Information-Communication-Technology' },
      { country: 'nz', category: 'technology',      joraCategory: 'Information-Communication-Technology' },
      { country: 'au', category: 'accounting',      joraCategory: 'Accounting' },
      { country: 'nz', category: 'accounting',      joraCategory: 'Accounting' },
      { country: 'au', category: 'hr',              joraCategory: 'Human-Resources-Recruitment' },
      { country: 'nz', category: 'hr',              joraCategory: 'Human-Resources-Recruitment' },
      { country: 'au', category: 'marketing',       joraCategory: 'Marketing-Communications' },
      { country: 'nz', category: 'marketing',       joraCategory: 'Marketing-Communications' },
      { country: 'au', category: 'sales',           joraCategory: 'Sales' },
      { country: 'nz', category: 'sales',           joraCategory: 'Sales' },
      { country: 'au', category: 'leadership',      joraCategory: 'General-Management' },
      { country: 'nz', category: 'leadership',      joraCategory: 'General-Management' },
    ]

    let total = 0
    for (const run of runs) {
      for (let page = 1; page <= 2; page++) {
        total += await scrapeJoraPage(supabase, run.country, run.category, run.joraCategory, page)
        await new Promise(r => setTimeout(r, 1000)) // 1s between pages
      }
    }

    return new Response(
      JSON.stringify({ success: true, inserted: total }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error(err)
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
