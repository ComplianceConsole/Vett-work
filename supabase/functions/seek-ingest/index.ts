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
  'skilled group', 'drake', 'korn ferry', 'spencer stuart', 'peoplescout',
  'alexander mann', 'kelly services', 'manpower group', 'talent international',
  'finite recruitment', 'paxus', 'DFP', 'DFP recruitment'
]

function isLikelyAgency(name: string): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  return AGENCY_KEYWORDS.some(kw => lower.includes(kw))
}

function cleanText(str: string): string {
  return (str || '').replace(/\s+/g, ' ').trim()
}

function extractContactName(text: string): string | null {
  if (!text) return null
  // Common patterns for contact names in job ads
  const patterns = [
    /contact\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
    /queries\s+to\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
    /speak\s+(?:to|with)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
    /please\s+contact\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
    /hiring\s+manager[:\s]+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
    /recruiter[:\s]+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
    /(?:call|email|contact)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)\s+(?:on|at|for)/i,
    /([A-Z][a-z]+\s+[A-Z][a-z]+)\s+is\s+the\s+(?:hiring|recruiting)/i,
    /attention[:\s]+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1] && match[1].length > 4 && match[1].length < 40) {
      return match[1].trim()
    }
  }
  return null
}

function makeShortDesc(desc: string): string {
  if (desc.length <= 200) return desc
  const cut = desc.substring(0, 197)
  const lastSpace = cut.lastIndexOf(' ')
  return cut.substring(0, lastSpace) + '...'
}

function parseSeekPage(html: string, country: string, category: string): Array<any> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (!doc) return []

  const cards = doc.querySelectorAll('[data-automation="normalJob"]')
  const jobs: any[] = []

  for (const card of Array.from(cards)) {
    try {
      const titleEl = card.querySelector('[data-automation="jobTitle"]')
      const companyEl = card.querySelector('[data-automation="jobCompany"]')
      const locationEl = card.querySelector('[data-automation="jobLocation"]')
      const salaryEl = card.querySelector('[data-automation="jobSalary"]')
      const listedEl = card.querySelector('[data-automation="jobListingDate"]')
      const linkEl = card.querySelector('a[href*="/job/"]')
      const descEl = card.querySelector('[data-automation="jobShortDescription"]') ||
                     card.querySelector('p') ||
                     card.querySelector('[class*="description"]')

      const title = cleanText(titleEl?.textContent || '')
      const company = cleanText(companyEl?.textContent || '')
      const location = cleanText(locationEl?.textContent || '')
      const salary = cleanText(salaryEl?.textContent || '')
      const listed = cleanText(listedEl?.textContent || '')
      const href = linkEl?.getAttribute('href') || ''
      const desc = cleanText(descEl?.textContent || '')
      
      // Extract contact name from description
      const contactName = extractContactName(desc)

      // Extract application email from card HTML and text
      const cardHtml = card.innerHTML || ''
      const cardText = card.textContent || ''
      // Check mailto links first, then bare email patterns in text
      const mailtoMatch = cardHtml.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i)
      const bareEmailMatch = cardText.match(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/)
      // Exclude seek's own emails and generic ones
      const rawEmail = (mailtoMatch?.[1] || bareEmailMatch?.[1] || '').toLowerCase()
      const applicationEmail = rawEmail && !rawEmail.includes('seek.com') && !rawEmail.includes('example.') ? rawEmail : null

      if (!title) continue
      if (company && isLikelyAgency(company)) continue
      const finalCompany = company || 'Company (via Seek)' 

      // Skip old listings
      if (listed.includes('30d') || listed.includes('14d')) continue

      // Extract job ID from URL
      const idMatch = href.match(/\/job\/(\d+)/)
      if (!idMatch) continue

      // Work type from location text
      const locLower = location.toLowerCase()
      const workType = locLower.includes('remote') ? 'remote' :
                       locLower.includes('hybrid') ? 'hybrid' : 'office'
      const cleanLocation = location.replace(/\(.*?\)/g, '').trim()

      // Employment type from listing text
      const cardText = cleanText(card.textContent || '').toLowerCase()
      const empType = cardText.includes('part time') || cardText.includes('part-time') ? 'parttime' :
                      cardText.includes('casual') ? 'casual' :
                      cardText.includes('contract') ? 'contractor' : 'fulltime'

      jobs.push({
        id: idMatch[1],
        title,
        company: finalCompany,
        location: cleanLocation,
        salary,
        desc,
        workType,
        empType,
        href: country === 'au' ? `https://au.seek.com${href}` : `https://www.seek.co.nz${href}`,
        applicationEmail,
        contactName,
        category,
        country,
      })
    } catch (err) {
      // skip
    }
  }

  return jobs
}

async function scrapeSeekPage(
  supabase: any,
  country: string,
  category: string,
  seekCategory: string,
  page: number
): Promise<number> {
  const baseUrl = country === 'au'
    ? `https://au.seek.com/jobs-in-${seekCategory}/in-All-Australia`
    : `https://www.seek.co.nz/jobs-in-${seekCategory}`
  
  const url = `${baseUrl}?daterange=7&sortmode=ListedDate&page=${page}`

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': country === 'au' ? 'en-AU,en;q=0.9' : 'en-NZ,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Referer': country === 'au' ? 'https://au.seek.com/' : 'https://www.seek.co.nz/',
  }

  const res = await fetch(url, { headers })
  if (!res.ok) {
    console.error(`Seek ${country}/${seekCategory} p${page}: ${res.status}`)
    return 0
  }

  const html = await res.text()
  const jobs = parseSeekPage(html, country, category)

  let inserted = 0

  for (const job of jobs) {
    try {
      const externalRef = `seek_${job.country}_${job.id}`
      const { data: existing } = await supabase.from('jobs').select('id').eq('external_reference', externalRef).single()
      if (existing) continue

      // Find or create employer
      let employerId: string | null = null
      const { data: existingEmp } = await supabase.from('employers')
        .select('id').eq('company_name', job.company).eq('source', 'seek').single()
      
      if (existingEmp) {
        employerId = existingEmp.id
      } else {
        const { data: newEmp } = await supabase.from('employers').insert({
          company_name: job.company,
          source: 'seek',
          email: `seek_${job.id}@placeholder.vettwork.internal`,
          company_type: 'direct',
          contact_name: job.contactName || null,
        }).select('id').single()
        if (newEmp) employerId = newEmp.id
      }

      if (!employerId) continue

      const desc = job.desc || job.title
      await supabase.from('jobs').insert({
        employer_id: employerId,
        title: job.title,
        description: desc,
        short_description: makeShortDesc(desc),
        location: job.location,
        salary_range: job.salary || null,
        employment_type: job.empType,
        work_type: job.workType,
        category: job.category,
        is_active: false,
        status: 'pending_review',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        external_reference: externalRef,
        application_url: job.href,
        application_email: job.applicationEmail || null,
        source: 'seek',
      })
      inserted++
    } catch (err) {
      console.error('Error inserting seek job:', err)
    }
  }

  if (jobs.length > 0) {
    console.log(`Seek ${country}/${seekCategory} p${page}: ${inserted} inserted from ${jobs.length} jobs. Sample: ${jobs[0].title} | ${jobs[0].company} | ${jobs[0].location} | desc:${jobs[0].desc.substring(0,30)}`)
  } else {
    console.log(`Seek ${country}/${seekCategory} p${page}: 0 inserted from 0 jobs`)
  }
  return inserted
}

// Seek category URL slugs
const SEEK_CATEGORIES: Record<string, string> = {
  technology:     'information-communication-technology',
  accounting:     'accounting',
  hr:             'human-resources-recruitment',
  marketing:      'marketing-communications',
  legal:          'legal',
  sales:          'sales',
  leadership:     'ceo-general-management',
  consulting:     'consulting-strategy',
  banking:        'banking-financial-services',
  administration: 'administration-office-support',
  community:      'community-services-development',
  education:      'education-training',
  engineering:    'engineering',
  healthcare:     'healthcare-medical',
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

    let batchFilter = 'technology'
    try {
      const body = await req.json()
      if (body?.batch) batchFilter = body.batch
    } catch { /* no body */ }

    const seekSlug = SEEK_CATEGORIES[batchFilter]
    if (!seekSlug) {
      return new Response(JSON.stringify({ error: `Unknown category: ${batchFilter}` }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Expire old seek jobs
    await supabase.from('jobs').update({ is_active: false })
      .eq('source', 'seek')
      .lt('expires_at', new Date().toISOString())

    let total = 0

    // AU - 3 pages per category
    for (let page = 1; page <= 3; page++) {
      total += await scrapeSeekPage(supabase, 'au', batchFilter, seekSlug, page)
      await new Promise(r => setTimeout(r, 1000))
    }

    // NZ - 2 pages
    for (let page = 1; page <= 2; page++) {
      total += await scrapeSeekPage(supabase, 'nz', batchFilter, seekSlug, page)
      await new Promise(r => setTimeout(r, 1000))
    }

    return new Response(
      JSON.stringify({ success: true, batch: batchFilter, inserted: total }),
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
