import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-api-key',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_SERVICE_KEY = Deno.env.get('DB_SERVICE_ROLE_KEY')
    const INGEST_API_KEY = Deno.env.get('JOB_INGEST_API_KEY')
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Authenticate the request
    const apiKey = req.headers.get('x-api-key') || new URL(req.url).searchParams.get('api_key')
    if (!apiKey || apiKey !== INGEST_API_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const contentType = req.headers.get('content-type') || ''
    let job: any = {}
    let command = 'add'

    // Handle XML (Broadbean/Idibu format)
    if (contentType.includes('xml') || contentType.includes('text/plain')) {
      const text = await req.text()
      job = parseXMLJob(text)
      command = job.command || 'add'
    }
    // Handle JSON (JobAdder/VONQ format)
    else if (contentType.includes('json')) {
      const data = await req.json()
      job = normaliseJSON(data)
      command = data.command || 'add'
    }
    // Handle form-encoded (some Broadbean configs)
    else if (contentType.includes('form')) {
      const form = await req.formData()
      const obj: any = {}
      form.forEach((value, key) => obj[key] = value)
      job = normaliseFormData(obj)
      command = obj.command || 'add'
    } else {
      // Try JSON as fallback
      try {
        const data = await req.json()
        job = normaliseJSON(data)
      } catch {
        return new Response(JSON.stringify({ error: 'Unsupported content type' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }

    // Handle delete/expire command
    if (command === 'delete' || command === 'expire') {
      if (job.job_reference) {
        await supabase.from('jobs')
          .update({ is_active: false })
          .eq('external_reference', job.job_reference)
      }
      return new Response(JSON.stringify({ success: true, action: 'deleted' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Find or create employer by email or company name
    let employerId = null

    if (job.contact_email) {
      const { data: existingEmp } = await supabase
        .from('employers')
        .select('id')
        .eq('email', job.contact_email)
        .single()

      if (existingEmp) {
        employerId = existingEmp.id
      } else {
        // Create a new employer record
        const { data: newEmp } = await supabase
          .from('employers')
          .insert({
            email: job.contact_email,
            company_name: job.company_name || job.contact_name || 'Unknown',
            source: job.source || 'api',
          })
          .select('id')
          .single()
        if (newEmp) employerId = newEmp.id
      }
    }

    if (!employerId) {
      return new Response(JSON.stringify({ error: 'Could not identify employer — contact_email required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Map category
    const category = mapCategory(job.job_industry || job.category || '')

    // Calculate expiry
    const daysToAdvertise = parseInt(job.days_to_advertise || '30')
    const expiresAt = new Date(Date.now() + daysToAdvertise * 24 * 60 * 60 * 1000).toISOString()

    // Check if job already exists (update) or is new (insert)
    if (job.job_reference) {
      const { data: existing } = await supabase
        .from('jobs')
        .select('id')
        .eq('external_reference', job.job_reference)
        .single()

      if (existing) {
        await supabase.from('jobs').update({
          title: job.job_title,
          description: job.job_description,
          location: job.job_location,
          salary_range: job.salary_range,
          employment_type: mapEmploymentType(job.job_type),
          work_type: mapWorkType(job.job_type),
          category,
          expires_at: expiresAt,
          is_active: true,
          application_url: job.application_url,
          application_email: job.application_email,
        }).eq('id', existing.id)

        return new Response(JSON.stringify({ success: true, action: 'updated', job_id: existing.id }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }

    // Insert new job
    const { data: newJob, error: insertError } = await supabase
      .from('jobs')
      .insert({
        employer_id: employerId,
        title: job.job_title || 'Untitled role',
        description: job.job_description || '',
        location: job.job_location || '',
        salary_range: job.salary_range || null,
        employment_type: mapEmploymentType(job.job_type),
        work_type: mapWorkType(job.job_type),
        category,
        is_active: true,
        expires_at: expiresAt,
        external_reference: job.job_reference || null,
        application_url: job.application_url || null,
        application_email: job.application_email || null,
        source: job.source || 'api',
      })
      .select('id')
      .single()

    if (insertError) throw insertError

    return new Response(
      JSON.stringify({ success: true, action: 'created', job_id: newJob.id }),
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

// ── PARSERS ──

function parseXMLJob(xml: string) {
  const get = (tag: string) => {
    const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
    return match ? match[1].trim() : ''
  }
  const salary_from = get('salary_from')
  const salary_to = get('salary_to')
  const salary_range = salary_from && salary_to ? `$${salary_from} – $${salary_to}` : salary_from || salary_to || ''

  return {
    command: get('command'),
    job_reference: get('job_reference'),
    job_title: get('job_title'),
    job_description: get('job_description'),
    job_location: get('job_location'),
    job_industry: get('job_industry'),
    job_type: get('job_type'),
    salary_range,
    days_to_advertise: get('days_to_advertise'),
    contact_email: get('contact_email') || get('application_email'),
    contact_name: get('contact_name'),
    company_name: get('contact_name'),
    application_url: get('application_url'),
    application_email: get('application_email'),
    source: 'broadbean',
  }
}

function normaliseJSON(data: any) {
  // JobAdder format
  if (data.jobTitle || data.JobTitle) {
    const salary = data.salary || data.Salary || {}
    return {
      job_reference: data.reference || data.jobId || data.id,
      job_title: data.jobTitle || data.JobTitle,
      job_description: data.description || data.jobDescription || '',
      job_location: data.location?.name || data.location || data.suburb || '',
      job_industry: data.category?.name || data.industry || '',
      job_type: data.workType || data.jobType || data.type || '',
      salary_range: salary.minimum && salary.maximum ? `$${salary.minimum} – $${salary.maximum}` : '',
      days_to_advertise: data.daysToAdvertise || 30,
      contact_email: data.contact?.email || data.contactEmail || data.email || '',
      company_name: data.company?.name || data.companyName || '',
      application_url: data.applicationUrl || data.applyUrl || '',
      application_email: data.applicationEmail || '',
      source: 'jobadder',
    }
  }

  // VONQ / generic JSON format
  return {
    job_reference: data.reference || data.externalId || data.id,
    job_title: data.title || data.jobTitle || data.job_title,
    job_description: data.description || data.jobDescription || data.job_description || '',
    job_location: data.location || data.city || '',
    job_industry: data.category || data.industry || '',
    job_type: data.employmentType || data.contractType || data.type || '',
    salary_range: data.salaryRange || data.salary || '',
    days_to_advertise: data.daysToAdvertise || 30,
    contact_email: data.contactEmail || data.email || '',
    company_name: data.companyName || data.employer || '',
    application_url: data.applicationUrl || data.applyUrl || '',
    source: 'vonq',
  }
}

function normaliseFormData(data: any) {
  const salary_from = data.salary_from || ''
  const salary_to = data.salary_to || ''
  return {
    command: data.command,
    job_reference: data.job_reference,
    job_title: data.job_title,
    job_description: data.job_description,
    job_location: data.job_location,
    job_industry: data.job_industry,
    job_type: data.job_type,
    salary_range: salary_from && salary_to ? `$${salary_from} – $${salary_to}` : '',
    days_to_advertise: data.days_to_advertise || 30,
    contact_email: data.contact_email || data.application_email,
    company_name: data.contact_name,
    application_url: data.application_url,
    application_email: data.application_email,
    source: 'idibu',
  }
}

// ── MAPPERS ──

function mapCategory(industry: string): string {
  const i = industry.toLowerCase()
  if (i.includes('account')) return 'accounting'
  if (i.includes('admin') || i.includes('office')) return 'administration'
  if (i.includes('advertis') || i.includes('media') || i.includes('art')) return 'advertising'
  if (i.includes('bank') || i.includes('financ')) return 'banking'
  if (i.includes('call') || i.includes('customer')) return 'callcentre'
  if (i.includes('ceo') || i.includes('general manag') || i.includes('executive')) return 'ceo'
  if (i.includes('communit') || i.includes('social')) return 'community'
  if (i.includes('construct') || i.includes('build')) return 'construction'
  if (i.includes('consult') || i.includes('strateg')) return 'consulting'
  if (i.includes('design') || i.includes('architect')) return 'design'
  if (i.includes('educat') || i.includes('train') || i.includes('teach')) return 'education'
  if (i.includes('engineer')) return 'engineering'
  if (i.includes('farm') || i.includes('agri') || i.includes('animal')) return 'farming'
  if (i.includes('government') || i.includes('defence') || i.includes('public')) return 'government'
  if (i.includes('health') || i.includes('medical') || i.includes('nurs')) return 'healthcare'
  if (i.includes('hospital') || i.includes('tourism') || i.includes('hotel')) return 'hospitality'
  if (i.includes('human res') || i.includes('recruit') || i.includes(' hr')) return 'hr'
  if (i.includes('ict') || i.includes('tech') || i.includes('software') || i.includes('it ')) return 'ict'
  if (i.includes('insurance') || i.includes('super')) return 'insurance'
  if (i.includes('legal') || i.includes('law')) return 'legal'
  if (i.includes('manufactur') || i.includes('transport') || i.includes('logistic')) return 'manufacturing'
  if (i.includes('market') || i.includes('communicat') || i.includes('pr')) return 'marketing'
  if (i.includes('mining') || i.includes('resource') || i.includes('energy')) return 'mining'
  if (i.includes('real estate') || i.includes('property')) return 'realestate'
  if (i.includes('retail') || i.includes('consumer')) return 'retail'
  if (i.includes('sales')) return 'sales'
  if (i.includes('science') || i.includes('research')) return 'science'
  if (i.includes('sport') || i.includes('recreation')) return 'sport'
  if (i.includes('trade') || i.includes('plumb') || i.includes('electr')) return 'trades'
  return 'other'
}

function mapEmploymentType(type: string): string {
  const t = (type || '').toLowerCase()
  if (t.includes('part')) return 'parttime'
  if (t.includes('casual') || t.includes('temp')) return 'casual'
  if (t.includes('contract') || t.includes('freelance')) return 'contractor'
  return 'fulltime'
}

function mapWorkType(type: string): string {
  const t = (type || '').toLowerCase()
  if (t.includes('remote') || t.includes('work from home') || t.includes('wfh')) return 'remote'
  if (t.includes('hybrid')) return 'hybrid'
  return 'office'
}
