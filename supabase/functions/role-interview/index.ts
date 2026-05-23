import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_SERVICE_KEY = Deno.env.get('DB_SERVICE_ROLE_KEY')
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    const { candidate_id, job_url, job_id } = await req.json()

    if (!candidate_id || !job_url) {
      return new Response(JSON.stringify({ error: 'Missing candidate_id or job_url' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const { data: candidate } = await supabase.from('candidates').select('cv_text, first_name, last_name').eq('id', candidate_id).single()
    if (!candidate?.cv_text) {
      return new Response(JSON.stringify({ error: 'No CV found — please upload your CV first' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    let employerContext = ''
    if (job_id) {
      const { data: job } = await supabase.from('jobs').select('*, employers(company_name, culture_description, company_values, candidate_criteria)').eq('id', job_id).single()
      if (job?.employers) {
        const emp = job.employers
        const parts = []
        if (emp.company_name) parts.push(`Company: ${emp.company_name}`)
        if (emp.culture_description) parts.push(`Culture: ${emp.culture_description}`)
        if (emp.company_values) {
          const vals = Array.isArray(emp.company_values) ? emp.company_values : JSON.parse(emp.company_values)
          if (vals.length > 0) parts.push(`Values: ${vals.join(', ')}`)
        }
        if (emp.candidate_criteria) parts.push(`What they look for: ${emp.candidate_criteria}`)
        employerContext = parts.join('\n')
      }
    }

    let jobAdText = ''
    try {
      const jobRes = await fetch(job_url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; vett.work/1.0)' } })
      const html = await jobRes.text()
      jobAdText = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 4000)
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Could not read the job ad URL. Please check the link and try again.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (!jobAdText || jobAdText.length < 100) {
      return new Response(JSON.stringify({ error: 'Could not extract enough text from the job ad.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const prompt = `You are helping a job candidate prepare a targeted video cover letter.

Job ad:
${jobAdText}

Candidate background:
${candidate.cv_text}

${employerContext ? `Company context:\n${employerContext}\n` : ''}

Generate exactly 3 questions covering: (1) why this role/company, (2) relevant achievement matching the role, (3) how they'd approach a key challenge.
Reference specifics from both the job ad and candidate CV. Warm conversational tone. 1-2 sentences each.
Return ONLY this JSON:
{"job_title":"...","company_name":"...","questions":["q1","q2","q3"]}`

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
    })

    const anthropicData = await anthropicRes.json()
    if (!anthropicRes.ok) throw new Error(anthropicData.error?.message || 'Anthropic API error')

    const parsed = JSON.parse(anthropicData.content[0].text.trim())

    const { data: interview, error: insertError } = await supabase.from('role_interviews').insert({
      candidate_id, job_url, job_title: parsed.job_title || 'Role interview', company_name: parsed.company_name || '',
      question_1: parsed.questions[0], question_2: parsed.questions[1], question_3: parsed.questions[2],
    }).select().single()

    if (insertError) throw insertError

    const { data: cand } = await supabase.from('candidates').select('role_interviews_remaining, role_interviews_unlimited_until').eq('id', candidate_id).single()
    const hasUnlimited = cand?.role_interviews_unlimited_until && new Date(cand.role_interviews_unlimited_until) > new Date()
    if (!hasUnlimited && cand?.role_interviews_remaining > 0) {
      await supabase.from('candidates').update({ role_interviews_remaining: cand.role_interviews_remaining - 1 }).eq('id', candidate_id)
    }

    return new Response(JSON.stringify({ success: true, interview_id: interview.id, job_title: parsed.job_title, company_name: parsed.company_name, questions: parsed.questions }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
