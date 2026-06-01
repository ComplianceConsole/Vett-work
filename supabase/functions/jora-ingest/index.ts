import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.38/deno-dom-wasm.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const AGENCY_KEYWORDS = [
  'recruitment','recruiting','staffing','talent solutions','hays','robert half',
  'hudson','randstad','adecco','michael page','people2people','chandler macleod',
  'skilled group','drake','korn ferry'
]

function isAgency(name: string): boolean {
  const l = (name||'').toLowerCase()
  return AGENCY_KEYWORDS.some(k => l.includes(k))
}

function clean(str: string): string {
  return (str||'')
    .replace(/<[^>]+>/g,' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ')
    .replace(/([a-z])([A-Z])/g,'$1 $2')
    .replace(/([.!?])([A-Z])/g,'$1 $2')
    .replace(/\s+/g,' ').trim()
}

function shortDesc(desc: string): string {
  const c = clean(desc)
  if (c.length <= 200) return c
  const cut = c.substring(0, 197)
  return cut.substring(0, cut.lastIndexOf(' ')) + '...'
}

function mapEmp(badge: string): string {
  const t = (badge||'').toLowerCase()
  if (t.includes('part')) return 'parttime'
  if (t.includes('casual')||t.includes('temp')) return 'casual'
  if (t.includes('contract')) return 'contractor'
  return 'fulltime'
}

function mapWork(text: string): string {
  const t = (text||'').toLowerCase()
  if (t.includes('remote')||t.includes('work from home')) return 'remote'
  if (t.includes('hybrid')) return 'hybrid'
  return 'office'
}

const BATCHES: Record<string, Array<{country: string, category: string, joraCategory: string}>> = {
  'tech':           [{country:'au',category:'technology',joraCategory:'Information-Communication-Technology'},{country:'nz',category:'technology',joraCategory:'Information-Communication-Technology'}],
  'accounting':     [{country:'au',category:'accounting',joraCategory:'Accounting'},{country:'nz',category:'accounting',joraCategory:'Accounting'}],
  'hr':             [{country:'au',category:'hr',joraCategory:'Human-Resources-Recruitment'},{country:'nz',category:'hr',joraCategory:'Human-Resources-Recruitment'}],
  'marketing':      [{country:'au',category:'marketing',joraCategory:'Marketing-Communications'},{country:'nz',category:'marketing',joraCategory:'Marketing-Communications'}],
  'sales':          [{country:'au',category:'sales',joraCategory:'Sales'},{country:'nz',category:'sales',joraCategory:'Sales'}],
  'leadership':     [{country:'au',category:'leadership',joraCategory:'General-Management'},{country:'nz',category:'leadership',joraCategory:'General-Management'}],
  'legal':          [{country:'au',category:'legal',joraCategory:'Legal'},{country:'nz',category:'legal',joraCategory:'Legal'}],
  'consulting':     [{country:'au',category:'consulting',joraCategory:'Consulting-Strategy'},{country:'nz',category:'consulting',joraCategory:'Consulting-Strategy'}],
  'banking':        [{country:'au',category:'banking',joraCategory:'Banking-Financial-Services'},{country:'nz',category:'banking',joraCategory:'Banking-Financial-Services'}],
  'community':      [{country:'au',category:'community',joraCategory:'Community-Services-Development'},{country:'nz',category:'community',joraCategory:'Community-Services-Development'}],
  'healthcare':     [{country:'au',category:'healthcare',joraCategory:'Healthcare-Medical'},{country:'nz',category:'healthcare',joraCategory:'Healthcare-Medical'}],
  'administration': [{country:'au',category:'administration',joraCategory:'Administration-Office-Support'},{country:'nz',category:'administration',joraCategory:'Administration-Office-Support'}],
  'engineering':    [{country:'au',category:'engineering',joraCategory:'Engineering'},{country:'nz',category:'engineering',joraCategory:'Engineering'}],
  'education':      [{country:'au',category:'education',joraCategory:'Education-Training'},{country:'nz',category:'education',joraCategory:'Education-Training'}],
  'realestate':     [{country:'au',category:'realestate',joraCategory:'Real-Estate-Property'},{country:'nz',category:'realestate',joraCategory:'Real-Estate-Property'}],
}

async function scrapePage(supabase: any, country: string, category: string, joraCategory: string, page: number): Promise<number> {
  const base = country === 'au' ? 'https://au.jora.com' : 'https://nz.jora.com'
  const url = `${base}/${joraCategory}-jobs?sp=facets&ca=${joraCategory.toLowerCase().replace(/-/g,'_')}&sort=date&p=${page}`

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-AU,en;q=0.9',
  }

  const res = await fetch(url, { headers })
  if (!res.ok) { console.log(`${country}/${joraCategory} p${page}: ${res.status}`); return 0 }

  const html = await res.text()
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (!doc) return 0

  const cards = doc.querySelectorAll('.job-card.result.organic-job')
  let inserted = 0

  for (const card of Array.from(cards)) {
    try {
      const el = card as Element
      const id = el.id?.replace('r_', '')
      if (!id) continue

      const title = clean((el.querySelector('.job-link') as Element)?.textContent || '')
      if (!title) continue

      const company = clean((el.querySelector('.job-company') as Element)?.textContent || '')
      if (!company || isAgency(company)) continue

      const location = clean((el.querySelector('.job-location') as Element)?.textContent || '')
      const snippet = clean((el.querySelector('.job-abstract') as Element)?.textContent || '')
      if (!snippet || snippet.length < 30) continue

      const dateText = clean((el.querySelector('.job-listed-date') as Element)?.textContent || '')
      if (dateText && (dateText.includes('30d') || dateText.includes('14d'))) continue

      const empBadge = clean((el.querySelector('.job-type, .badges') as Element)?.textContent || '')
      const jobUrl = (el.querySelector('a.job-link') as HTMLAnchorElement)?.href || ''

      const externalRef = `jora_${id}`
      const { data: existing } = await supabase.from('jobs').select('id').eq('external_reference', externalRef).single()
      if (existing) continue

      let employerId: string | null = null
      const { data: existingEmp } = await supabase.from('employers').select('id').eq('company_name', company).eq('source', 'jora').single()
      if (existingEmp) {
        employerId = existingEmp.id
      } else {
        const { data: newEmp } = await supabase.from('employers').insert({
          company_name: company, source: 'jora',
          email: `jora_${id}@placeholder.vettwork.internal`,
          company_type: 'direct',
        }).select('id').single()
        if (newEmp) employerId = newEmp.id
      }
      if (!employerId) continue

      // Fetch full description from job detail page
      let fullDesc = snippet
      let appEmail: string | null = null
      let contactName: string | null = null
      
      if (jobUrl) {
        try {
          const detailRes = await fetch(jobUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml',
              'Accept-Language': country === 'au' ? 'en-AU,en;q=0.9' : 'en-NZ,en;q=0.9',
            }
          })
          if (detailRes.ok) {
            const detailHtml = await detailRes.text()
            const detailDoc = new DOMParser().parseFromString(detailHtml, 'text/html')
            if (detailDoc) {
              const descEl = detailDoc.querySelector('.job-description, .description, [class*="description"]')
              const detailDesc = cleanText(descEl?.textContent || '')
              if (detailDesc.length > fullDesc.length) fullDesc = detailDesc
              
              // Extract email
              const emailMatch = detailHtml.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i)
              const rawEmail = emailMatch?.[1]?.toLowerCase()
              if (rawEmail && !rawEmail.includes('jora.')) appEmail = rawEmail

              // Extract contact name
              const contactPatterns = [/contact\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i, /speak\s+(?:to|with)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i]
              for (const p of contactPatterns) {
                const m = fullDesc.match(p)
                if (m?.[1] && m[1].length > 4 && m[1].length < 40) { contactName = m[1].trim(); break }
              }
            }
          }
          await new Promise(r => setTimeout(r, 300))
        } catch { /* use snippet */ }
      }

      await supabase.from('jobs').insert({
        employer_id: employerId, title, description: fullDesc,
        short_description: shortDesc(fullDesc), location,
        employment_type: mapEmp(empBadge), work_type: mapWork(empBadge + ' ' + fullDesc),
        category, is_active: false, status: 'pending_review',
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        external_reference: externalRef, application_url: jobUrl || null, 
        application_email: appEmail, source: 'jora',
      })
      inserted++
    } catch (err) {
      console.error('job error:', err)
    }
  }

  console.log(`Jora ${country}/${joraCategory} p${page}: ${inserted} inserted from ${cards.length} cards`)
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

    const reqUrl = new URL(req.url)
    let batch = reqUrl.searchParams.get('batch') || 'tech'
    try { const body = await req.json(); if (body.batch) batch = body.batch } catch {}

    const runs = BATCHES[batch] || BATCHES['tech']
    console.log(`Running batch: ${batch}`)

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    await supabase.from('jobs').update({ is_active: false })
      .eq('source', 'jora').lt('expires_at', new Date().toISOString())

    let total = 0
    for (const run of runs) {
      // 2 pages per country
      for (let page = 1; page <= 2; page++) {
        total += await scrapePage(supabase, run.country, run.category, run.joraCategory, page)
        await new Promise(r => setTimeout(r, 800))
      }
      await new Promise(r => setTimeout(r, 1000))
    }

    return new Response(
      JSON.stringify({ success: true, batch, inserted: total }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
