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
  'skilled group', 'drake', 'jones lang', 'spencer stuart', 'korn ferry'
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
    .replace(/\s+/g, ' ')
    .trim()
}

function shortDesc(desc: string): string {
  const clean = cleanText(desc)
  const sentences = clean.split(/[.!?]+/).filter(s => s.trim().length > 20)
  return sentences.slice(0, 2).join('. ').substring(0, 200).trim() + '.'
}

function mapCategory(title: string, desc: string): string {
  const t = (title + ' ' + desc).toLowerCase()
  if (t.match(/\bit\b|software|developer|devops|cloud|cyber|tech|digital|data science|machine learn|full.?stack|front.?end|back.?end/)) return 'technology'
  if (t.match(/account|finance|financial|tax|audit|bookkeep|payroll|cfo|controller/)) return 'accounting'
  if (t.match(/\bhr\b|human res|recruit|talent|people.*culture|workforce|learning.*dev/)) return 'hr'
  if (t.match(/market|brand|content|seo|social media|campaign|communications|pr\b|public rel/)) return 'marketing'
  if (t.match(/legal|lawyer|solicitor|barrister|compliance|paralegal|convey/)) return 'legal'
  if (t.match(/sales|account exec|business dev|bdr|sdr|revenue|client.*success/)) return 'sales'
  if (t.match(/ceo|coo|director|general man|vp |vice pres|chief |head of|leadership/)) return 'leadership'
  if (t.match(/admin|office man|receptionist|executive assist|coordinator|operations/)) return 'administration'
  if (t.match(/bank|insurance|mortgage|wealth|financial plann|superannuation/)) return 'banking'
  if (t.match(/consult|strategy|advisory|analyst|management consult/)) return 'consulting'
  return 'administration'
}

function mapEmpType(jobType: string): string {
  const t = (jobType || '').toLowerCase()
  if (t.includes('part')) return 'parttime'
  if (t.includes('casual') || t.includes('temp') || t.includes('contract')) return 'contractor'
  return 'fulltime'
}

async function fetchCareerjetJobs(supabase: any, apiKey: string, country: string, keyword: string, vettCategory: string) {
  const url = new URL('http://public.api.careerjet.com/search')
  url.searchParams.set('affid', apiKey)
  url.searchParams.set('keywords', keyword)
  url.searchParams.set('location', country === 'au' ? 'Australia' : 'New Zealand')
  url.searchParams.set('locale_code', country === 'au' ? 'en_AU' : 'en_NZ')
  url.searchParams.set('pagesize', '50')
  url.searchParams.set('sort', 'date')

  const res = await fetch(url.toString())
  if (!res.ok) { console.error(`Careerjet error ${country}/${keyword}: ${res.status}`); return 0 }

  const data = await res.json()
  if (data.type !== 'JOBS') return 0

  const jobs = data.jobs || []
  let inserted = 0

  for (const job of jobs) {
    try {
      // Skip agencies
      if (isLikelyAgency(job.company || '')) continue

      const desc = cleanText(job.description || '')
      if (desc.length < 150) continue

      // Dedup by URL
      const externalRef = `careerjet_${Buffer.from(job.url).toString('base64').substring(0, 40)}`
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
          email: `careerjet_${Date.now()}_${Math.random().toString(36).substring(7)}@placeholder.vettwork.internal`,
          company_type: 'direct',
        }).select('id').single()
        if (newEmp) employerId = newEmp.id
      }

      if (!employerId) continue

      const category = vettCategory || mapCategory(job.title || '', desc)

      await supabase.from('jobs').insert({
        employer_id: employerId,
        title: cleanText(job.title || ''),
        description: desc,
        short_description: shortDesc(job.description || ''),
        location: cleanText(job.locations || '') || (country === 'au' ? 'Australia' : 'New Zealand'),
        employment_type: mapEmpType(job.job_type || ''),
        work_type: 'office',
        category,
        is_active: false,
        status: 'pending_review',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        external_reference: externalRef,
        application_url: job.url || null,
        source: 'careerjet',
      })
      inserted++
    } catch (err) {
      console.error('Error processing careerjet job:', err)
    }
  }

  console.log(`Careerjet ${country}/${keyword}: ${inserted} inserted`)
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
      return new Response(JSON.stringify({ error: 'Careerjet API key not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Expire old careerjet jobs
    await supabase.from('jobs').update({ is_active: false }).eq('source', 'careerjet').lt('expires_at', new Date().toISOString())

    // White collar keyword/category pairs
    const searches = [
      { keyword: 'software developer',     category: 'technology' },
      { keyword: 'IT manager',             category: 'technology' },
      { keyword: 'data analyst',           category: 'technology' },
      { keyword: 'accountant',             category: 'accounting' },
      { keyword: 'finance manager',        category: 'accounting' },
      { keyword: 'HR manager',             category: 'hr' },
      { keyword: 'marketing manager',      category: 'marketing' },
      { keyword: 'digital marketing',      category: 'marketing' },
      { keyword: 'lawyer solicitor',       category: 'legal' },
      { keyword: 'sales manager',          category: 'sales' },
      { keyword: 'business development',   category: 'sales' },
      { keyword: 'general manager',        category: 'leadership' },
      { keyword: 'operations manager',     category: 'leadership' },
    ]

    const countries = ['au', 'nz']
    let total = 0

    for (const country of countries) {
      for (const s of searches) {
        total += await fetchCareerjetJobs(supabase, CAREERJET_API_KEY, country, s.keyword, s.category)
        await new Promise(r => setTimeout(r, 200))
      }
    }

    return new Response(JSON.stringify({ success: true, inserted: total }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
