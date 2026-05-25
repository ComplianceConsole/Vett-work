import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const AGENCY_KEYWORDS = [
  'recruitment', 'recruiting', 'staffing', 'talent solutions', 'executive search',
  'headhunt', 'labour hire', 'labor hire', 'manpower', 'hays', 'robert half',
  'hudson', 'randstad', 'adecco', 'michael page', 'people2people', 'chandler macleod',
  'skilled group', 'drake', 'korn ferry', 'spencer stuart'
]

function isLikelyAgency(name: string): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  return AGENCY_KEYWORDS.some(kw => lower.includes(kw))
}

function cleanText(str: string): string {
  return (str || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim()
}

function shortDesc(desc: string): string {
  const clean = cleanText(desc)
  const sentences = clean.split(/[.!?]+/).filter(s => s.trim().length > 20)
  return sentences.slice(0, 2).join('. ').substring(0, 200).trim() + '.'
}

function mapCategory(title: string, desc: string): string {
  const t = (title + ' ' + desc).toLowerCase()
  if (t.match(/\bit\b|software|developer|devops|cloud|cyber|tech|digital|data science|machine learn|full.?stack|front.?end|back.?end/)) return 'technology'
  if (t.match(/account|finance|financial|tax|audit|bookkeep|payroll|cfo/)) return 'accounting'
  if (t.match(/\bhr\b|human res|recruit|talent|people.*culture|workforce/)) return 'hr'
  if (t.match(/market|brand|content|seo|social media|campaign|communications/)) return 'marketing'
  if (t.match(/legal|lawyer|solicitor|barrister|compliance|paralegal/)) return 'legal'
  if (t.match(/sales|account exec|business dev|bdr|sdr|revenue/)) return 'sales'
  if (t.match(/ceo|coo|director|general man|vp |vice pres|chief |head of/)) return 'leadership'
  if (t.match(/bank|insurance|mortgage|wealth|financial plann|superannuation/)) return 'banking'
  if (t.match(/consult|strategy|advisory|management consult/)) return 'consulting'
  return 'administration'
}

function formatSalary(job: any): string | null {
  if (!job.salary_min && !job.salary_max) return null
  const currency = job.salary_currency_code || 'AUD'
  const sym = currency === 'NZD' ? 'NZ$' : '$'
  const type = job.salary_type === 'Y' ? '/yr' : job.salary_type === 'M' ? '/mo' : job.salary_type === 'H' ? '/hr' : ''
  if (job.salary_min && job.salary_max) {
    return `${sym}${Math.round(job.salary_min).toLocaleString()}–${sym}${Math.round(job.salary_max).toLocaleString()}${type}`
  }
  return job.salary_min ? `From ${sym}${Math.round(job.salary_min).toLocaleString()}${type}` : null
}

async function fetchJobs(supabase: any, apiKey: string, localeCode: string, keyword: string, category: string) {
  // Basic auth: base64(apiKey + ":")
  const credentials = btoa(apiKey + ':')
  
  const url = new URL('https://search.api.careerjet.net/v4/query')
  url.searchParams.set('locale_code', localeCode)
  url.searchParams.set('keywords', keyword)
  url.searchParams.set('sort', 'date')
  url.searchParams.set('page_size', '50')
  url.searchParams.set('fragment_size', '500')
  url.searchParams.set('user_ip', '1.1.1.1')
  url.searchParams.set('user_agent', 'vett.work/1.0 job-ingest-bot')

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Basic ${credentials}`,
      'User-Agent': 'vett.work/1.0 job-ingest-bot',
    }
  })

  if (!res.ok) { 
    console.error(`Careerjet error ${localeCode}/${keyword}: ${res.status} ${await res.text()}`)
    return 0 
  }

  const data = await res.json()
  if (data.type !== 'JOBS') {
    console.log(`Careerjet ${localeCode}/${keyword}: ${data.message}`)
    return 0
  }

  const jobs = data.jobs || []
  let inserted = 0

  for (const job of jobs) {
    try {
      if (isLikelyAgency(job.company || '')) continue

      const desc = cleanText(job.description || '')
      if (desc.length < 150) continue

      // Deduplicate by URL
      const externalRef = `careerjet_${job.url.split('/').pop()?.substring(0, 40) || Math.random().toString(36)}`
      const { data: existing } = await supabase.from('jobs').select('id').eq('external_reference', externalRef).single()
      if (existing) continue

      // Find or create employer
      const companyName = job.company || 'Company'
      let employerId: string | null = null
      const { data: existingEmp } = await supabase.from('employers').select('id').eq('company_name', companyName).eq('source', 'careerjet').single()
      if (existingEmp) {
        employerId = existingEmp.id
      } else {
        const { data: newEmp } = await supabase.from('employers').insert({
          company_name: companyName,
          source: 'careerjet',
          email: `cj_${Date.now()}_${Math.random().toString(36).substring(7)}@placeholder.vettwork.internal`,
          company_type: 'direct',
        }).select('id').single()
        if (newEmp) employerId = newEmp.id
      }

      if (!employerId) continue

      const detectedCategory = category || mapCategory(job.title || '', desc)
      const salaryRange = formatSalary(job)
      // Only include if salary is listed (quality filter)
      if (!salaryRange) continue

      await supabase.from('jobs').insert({
        employer_id: employerId,
        title: cleanText(job.title || ''),
        description: desc,
        short_description: shortDesc(job.description || ''),
        location: cleanText(job.locations || '') || (localeCode.includes('AU') ? 'Australia' : 'New Zealand'),
        salary_range: salaryRange,
        employment_type: 'fulltime',
        work_type: 'office',
        category: detectedCategory,
        is_active: false,
        status: 'pending_review',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        external_reference: externalRef,
        application_url: job.url || null,
        source: 'careerjet',
      })
      inserted++
    } catch (err) {
      console.error('Error processing job:', err)
    }
  }

  console.log(`Careerjet ${localeCode}/${keyword}: ${inserted} inserted from ${jobs.length}`)
  return inserted
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SUPABASE_SERVICE_KEY = Deno.env.get('DB_SERVICE_ROLE_KEY')!
    const CAREERJET_API_KEY = Deno.env.get('CAREERJET_API_KEY')!
    const INGEST_API_KEY = Deno.env.get('JOB_INGEST_API_KEY')

    const apiKey = req.headers.get('x-api-key')
    if (apiKey !== INGEST_API_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (!CAREERJET_API_KEY) {
      return new Response(JSON.stringify({ error: 'CAREERJET_API_KEY not set' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Expire old careerjet jobs
    await supabase.from('jobs').update({ is_active: false }).eq('source', 'careerjet').lt('expires_at', new Date().toISOString())

    const searches = [
      { keyword: 'software developer',   category: 'technology' },
      { keyword: 'IT manager',           category: 'technology' },
      { keyword: 'data analyst',         category: 'technology' },
      { keyword: 'accountant',           category: 'accounting' },
      { keyword: 'finance manager',      category: 'accounting' },
      { keyword: 'HR manager',           category: 'hr' },
      { keyword: 'marketing manager',    category: 'marketing' },
      { keyword: 'digital marketing',    category: 'marketing' },
      { keyword: 'solicitor lawyer',     category: 'legal' },
      { keyword: 'sales manager',        category: 'sales' },
      { keyword: 'business development', category: 'sales' },
      { keyword: 'general manager',      category: 'leadership' },
      { keyword: 'operations manager',   category: 'leadership' },
    ]

    // AU and NZ locale codes
    const locales = ['en_AU', 'en_NZ']
    let total = 0

    for (const locale of locales) {
      for (const s of searches) {
        total += await fetchJobs(supabase, CAREERJET_API_KEY, locale, s.keyword, s.category)
        await new Promise(r => setTimeout(r, 250))
      }
    }

    return new Response(JSON.stringify({ success: true, inserted: total }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
