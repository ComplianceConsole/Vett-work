import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.38/deno-dom-wasm.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const AGENCY_KEYWORDS = [
  'recruitment', 'recruiting', 'staffing', 'talent', 'headhunt',
  'labour hire', 'labor hire', 'manpower', 'hays', 'robert half',
  'hudson', 'randstad', 'adecco', 'michael page', 'people2people'
]

function isLikelyAgency(name: string): boolean {
  const lower = (name || '').toLowerCase()
  return AGENCY_KEYWORDS.some(kw => lower.includes(kw))
}

function cleanText(str: string): string {
  return (str || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function makeShortDesc(desc: string): string {
  if (desc.length <= 200) return desc
  const cut = desc.substring(0, 197)
  const lastSpace = cut.lastIndexOf(' ')
  return cut.substring(0, lastSpace) + '...'
}

function mapCategory(keyword: string): string {
  const k = keyword.toLowerCase()
  if (k.includes('nurs') || k.includes('midwi') || k.includes('health') || k.includes('medical') || k.includes('allied')) return 'healthcare'
  if (k.includes('aged') || k.includes('disability') || k.includes('social') || k.includes('community')) return 'community'
  if (k.includes('tech') || k.includes('software') || k.includes('developer') || k.includes('it ')) return 'technology'
  if (k.includes('hr') || k.includes('human res') || k.includes('recruit')) return 'hr'
  if (k.includes('account') || k.includes('finance')) return 'accounting'
  if (k.includes('market')) return 'marketing'
  if (k.includes('sales')) return 'sales'
  if (k.includes('legal') || k.includes('lawyer')) return 'legal'
  if (k.includes('educat') || k.includes('teacher') || k.includes('school')) return 'education'
  return 'administration'
}

async function scrapeTradeMePage(
  supabase: any,
  keyword: string,
  category: string,
  page: number
): Promise<number> {
  const url = `https://www.trademe.co.nz/a/jobs/search?search_string=${encodeURIComponent(keyword)}&sort_order=1&page=${page}`
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-NZ,en;q=0.9',
    'Cache-Control': 'no-cache',
  }

  const res = await fetch(url, { headers })
  if (!res.ok) { console.error(`TradeMe error ${keyword} p${page}: ${res.status}`); return 0 }

  const html = await res.text()
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (!doc) return 0

  // Extract job data from listing links and their parent containers
  const listingLinks = doc.querySelectorAll('a[href*="/jobs/"][href*="/listing/"]')
  let inserted = 0

  const seen = new Set<string>()

  for (const link of Array.from(listingLinks)) {
    try {
      const href = (link as Element).getAttribute('href') || ''
      if (!href) continue

      // Extract listing ID from URL
      const match = href.match(/\/listing\/(\d+)/)
      if (!match) continue
      const listingId = match[1]
      if (seen.has(listingId)) continue
      seen.add(listingId)

      // Get parent container text
      const parent = (link as Element).parentElement?.parentElement || (link as Element).parentElement
      const fullText = cleanText(parent?.textContent || '')
      
      // Parse title from link text
      const title = cleanText((link as Element).textContent || '')
      if (!title || title.length < 3) continue

      // Parse location - look for NZ city names in text
      const locationMatch = fullText.match(/\b(Auckland|Wellington|Christchurch|Hamilton|Tauranga|Dunedin|Palmerston North|Nelson|Rotorua|New Plymouth|Whangarei|Invercargill|Napier|Hastings|Porirua|Upper Hutt|Lower Hutt|Queenstown)\b[^,\n]*/i)
      const location = locationMatch ? locationMatch[0].trim().substring(0, 60) : 'New Zealand'

      // Get description snippet
      const descStart = fullText.indexOf(title) + title.length
      const desc = fullText.substring(descStart).replace(/\d+ days? ago/i, '').trim()

      if (desc.length < 30) continue

      // Skip old listings (30+ days)
      if (fullText.includes('30 days ago')) continue

      const externalRef = `trademe_${listingId}`
      const { data: existing } = await supabase.from('jobs').select('id').eq('external_reference', externalRef).single()
      if (existing) continue

      // Company name - Trade Me doesn't always show it in list view, use job title context
      const companyName = 'New Zealand Health'
      if (isLikelyAgency(companyName)) continue

      // Find or create employer
      let employerId: string | null = null
      const { data: existingEmp } = await supabase.from('employers').select('id').eq('company_name', companyName).eq('source', 'trademe').single()
      if (existingEmp) {
        employerId = existingEmp.id
      } else {
        const { data: newEmp } = await supabase.from('employers').insert({
          company_name: companyName,
          source: 'trademe',
          email: `trademe_${listingId}@placeholder.vettwork.internal`,
          company_type: 'direct',
        }).select('id').single()
        if (newEmp) employerId = newEmp.id
      }
      if (!employerId) continue

      await supabase.from('jobs').insert({
        employer_id: employerId,
        title,
        description: desc,
        short_description: makeShortDesc(desc),
        location,
        employment_type: href.includes('part-time') ? 'parttime' : 'fulltime',
        work_type: 'office',
        category,
        is_active: false,
        status: 'pending_review',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        external_reference: externalRef,
        application_url: `https://www.trademe.co.nz${href}`,
        source: 'trademe',
      })
      inserted++
    } catch (err) {
      console.error('Error processing TradeMe job:', err)
    }
  }

  console.log(`TradeMe ${keyword} p${page}: ${inserted} inserted from ${seen.size} listings`)
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
      return new Response(JSON.stringify({ error: 'Unauthorised' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Expire old trademe jobs
    await supabase.from('jobs').update({ is_active: false }).eq('source', 'trademe').lt('expires_at', new Date().toISOString())

    // Healthcare focused keywords for NZ
    const searches = [
      { keyword: 'registered nurse',     category: 'healthcare' },
      { keyword: 'midwife',              category: 'healthcare' },
      { keyword: 'allied health',        category: 'healthcare' },
      { keyword: 'physiotherapist',      category: 'healthcare' },
      { keyword: 'occupational therapist', category: 'healthcare' },
      { keyword: 'social worker',        category: 'community' },
      { keyword: 'disability support',   category: 'community' },
      { keyword: 'aged care',            category: 'community' },
      { keyword: 'GP practice manager',  category: 'healthcare' },
      { keyword: 'medical',              category: 'healthcare' },
    ]

    let total = 0
    for (const s of searches) {
      for (let page = 1; page <= 2; page++) {
        total += await scrapeTradeMePage(supabase, s.keyword, s.category, page)
        await new Promise(r => setTimeout(r, 1000))
      }
    }

    return new Response(JSON.stringify({ success: true, inserted: total }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
