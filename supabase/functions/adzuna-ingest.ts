import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Adzuna category IDs mapped to our categories
const ADZUNA_CATEGORY_MAP: Record<string, string> = {
  'it-jobs': 'technology',
  'accounting-finance-jobs': 'accounting',
  'hr-jobs': 'hr',
  'marketing-jobs': 'marketing',
  'legal-jobs': 'legal',
  'sales-jobs': 'sales',
  'consulting-jobs': 'consulting',
  'management-jobs': 'leadership',
  'banking-finance-jobs': 'banking',
  'admin-jobs': 'administration',
}

// Words that suggest a recruitment agency
const AGENCY_KEYWORDS = [
  'recruitment', 'recruiting', 'staffing', 'talent', 'executive search',
  'headhunt', 'labour hire', 'labour-hire', 'labor hire', 'manpower',
  'hays', 'robert half', 'hudson', 'randstad', 'adecco', 'michael page',
  'people2people', 'seek employment', 'chandler macleod', 'skilled'
]

function isLikelyAgency(companyName: string): boolean {
  if (!companyName) return false
  const lower = companyName.toLowerCase()
  return AGENCY_KEYWORDS.some(kw => lower.includes(kw))
}

function cleanDescription(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function makeShortDescription(desc: string): string {
  const clean = cleanDescription(desc)
  const sentences = clean.split(/[.!?]+/).filter(s => s.trim().length > 20)
  return sentences.slice(0, 2).join('. ').substring(0, 200).trim() + (clean.length > 200 ? '.' : '')
}

function mapWorkType(jobType: string): string {
  const t = (jobType || '').toLowerCase()
  if (t.includes('remote') || t.includes('work from home')) return 'remote'
  if (t.includes('hybrid')) return 'hybrid'
  return 'office'
}

function mapEmpType(contractType: string): string {
  const t = (contractType || '').toLowerCase()
  if (t.includes('part')) return 'parttime'
  if (t.includes('casual') || t.includes('temp')) return 'casual'
  if (t.includes('contract') || t.includes('freelance')) return 'contractor'
  return 'fulltime'
}

async function fetchAdzunaJobs(
  supabase: any,
  appId: string,
  appKey: string,
  country: string, // 'au' or 'nz'
  category: string,
  vettCategory: string
) {
  const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`)
  url.searchParams.set('app_id', appId)
  url.searchParams.set('app_key', appKey)
  url.searchParams.set('results_per_page', '50')
  url.searchParams.set('category', category)
  url.searchParams.set('sort_by', 'date')
  url.searchParams.set('max_days_old', '7')
  url.searchParams.set('salary_include_unknown', '0') // only roles with salary

  const res = await fetch(url.toString())
  if (!res.ok) {
    console.error(`Adzuna API error for ${country}/${category}: ${res.status}`)
    return 0
  }

  const data = await res.json()
  const jobs = data.results || []
  let inserted = 0
  let skipped = 0

  for (const job of jobs) {
    try {
      // Skip agencies
      if (isLikelyAgency(job.company?.display_name || '')) {
        skipped++
        continue
      }

      // Skip short descriptions
      const desc = cleanDescription(job.description || '')
      if (desc.length < 200) {
        skipped++
        continue
      }

      // Check if already exists by external reference
      const externalRef = `adzuna_${job.id}`
      const { data: existing } = await supabase
        .from('jobs')
        .select('id')
        .eq('external_reference', externalRef)
        .single()

      if (existing) {
        // Update expiry if still fresh
        await supabase.from('jobs').update({
          is_active: true,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        }).eq('id', existing.id)
        continue
      }

      // Find or create a system employer for Adzuna
      const companyName = job.company?.display_name || 'Company'
      let employerId: string | null = null

      const { data: existingEmp } = await supabase
        .from('employers')
        .select('id')
        .eq('company_name', companyName)
        .eq('source', 'adzuna')
        .single()

      if (existingEmp) {
        employerId = existingEmp.id
      } else {
        const { data: newEmp } = await supabase
          .from('employers')
          .insert({
            company_name: companyName,
            source: 'adzuna',
            email: `adzuna_${job.id}@placeholder.vettwork.internal`,
            company_type: 'direct',
          })
          .select('id')
          .single()
        if (newEmp) employerId = newEmp.id
      }

      if (!employerId) continue

      // Build salary range
      const salMin = job.salary_min ? Math.round(job.salary_min) : null
      const salMax = job.salary_max ? Math.round(job.salary_max) : null
      const salaryRange = salMin && salMax
        ? `$${salMin.toLocaleString()}–$${salMax.toLocaleString()}`
        : salMin ? `From $${salMin.toLocaleString()}`
        : salMax ? `To $${salMax.toLocaleString()}` : null

      // Location
      const location = [
        job.location?.display_name,
        job.location?.area?.[1]
      ].filter(Boolean).join(', ') || (country === 'au' ? 'Australia' : 'New Zealand')

      const shortDesc = makeShortDescription(job.description || '')

      await supabase.from('jobs').insert({
        employer_id: employerId,
        title: job.title,
        description: desc,
        short_description: shortDesc,
        location,
        salary_range: salaryRange,
        employment_type: mapEmpType(job.contract_type || ''),
        work_type: mapWorkType(job.contract_time || ''),
        category: vettCategory,
        is_active: false,
        status: 'pending_review',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        external_reference: externalRef,
        application_url: job.redirect_url || null,
        source: 'adzuna',
      })

      inserted++
    } catch (err) {
      console.error(`Error processing job ${job.id}:`, err)
    }
  }

  console.log(`${country}/${category}: ${inserted} inserted, ${skipped} skipped`)
  return inserted
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_SERVICE_KEY = Deno.env.get('DB_SERVICE_ROLE_KEY')
    const ADZUNA_APP_ID = Deno.env.get('ADZUNA_APP_ID')
    const ADZUNA_APP_KEY = Deno.env.get('ADZUNA_APP_KEY')
    const INGEST_API_KEY = Deno.env.get('JOB_INGEST_API_KEY')

    // Auth check
    const apiKey = req.headers.get('x-api-key')
    if (apiKey !== INGEST_API_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
      return new Response(JSON.stringify({ error: 'Adzuna credentials not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!)

    // First expire any old Adzuna jobs older than 8 days
    await supabase
      .from('jobs')
      .update({ is_active: false })
      .eq('source', 'adzuna')
      .lt('expires_at', new Date().toISOString())

    // Categories to fetch — white collar focus
    const categories = [
      { adzuna: 'it-jobs',              vett: 'technology' },
      { adzuna: 'accounting-finance-jobs', vett: 'accounting' },
      { adzuna: 'hr-jobs',              vett: 'hr' },
      { adzuna: 'marketing-jobs',       vett: 'marketing' },
      { adzuna: 'legal-jobs',           vett: 'legal' },
      { adzuna: 'sales-jobs',           vett: 'sales' },
      { adzuna: 'management-jobs',      vett: 'leadership' },
    ]

    const countries = ['au', 'nz']
    let totalInserted = 0

    for (const country of countries) {
      for (const cat of categories) {
        const count = await fetchAdzunaJobs(
          supabase, ADZUNA_APP_ID, ADZUNA_APP_KEY,
          country, cat.adzuna, cat.vett
        )
        totalInserted += count
        // Small delay to be polite to the API
        await new Promise(r => setTimeout(r, 300))
      }
    }

    return new Response(
      JSON.stringify({ success: true, inserted: totalInserted }),
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
