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

    const { candidate_id, job_url } = await req.json()

    if (!candidate_id || !job_url) {
      return new Response(
        JSON.stringify({ error: 'Missing candidate_id or job_url' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Load candidate CV
    const { data: candidate } = await supabase
      .from('candidates')
      .select('cv_text, first_name, last_name')
      .eq('id', candidate_id)
      .single()

    if (!candidate?.cv_text) {
      return new Response(
        JSON.stringify({ error: 'No CV found for this candidate' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Fetch the job ad URL
    let jobAdText = ''
    try {
      const jobRes = await fetch(job_url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; vett.work/1.0)' }
      })
      const html = await jobRes.text()
      // Strip HTML tags to get plain text
      jobAdText = html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 4000)
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Could not read the job ad URL. Please check the link and try again.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!jobAdText || jobAdText.length < 100) {
      return new Response(
        JSON.stringify({ error: 'Could not extract enough text from the job ad. Try copying the job description instead.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Generate 3 role-specific questions using Anthropic
    const prompt = `You are helping a job candidate prepare a targeted video cover letter for a specific role.

Here is the job ad:
${jobAdText}

Here is the candidate's background:
${candidate.cv_text}

Generate exactly 3 interview questions tailored to this specific role and this specific candidate's background.

Rules:
- Questions must be specific to the role requirements AND the candidate's actual experience
- Reference specific skills, responsibilities or requirements from the job ad where possible
- Reference specific experience or achievements from the candidate's CV where possible
- Warm, conversational tone — not corporate
- Each question should be 1-2 sentences max
- Cover these three angles: (1) why they want this specific role/company, (2) a relevant skill or achievement from their background that matches the role, (3) how they would approach a key challenge or responsibility in this role
- Return ONLY a JSON object with these fields, no other text:
{
  "job_title": "extracted job title",
  "company_name": "extracted company name",
  "questions": ["question 1", "question 2", "question 3"]
}`

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      })
    })

    const anthropicData = await anthropicRes.json()
    if (!anthropicRes.ok) throw new Error(anthropicData.error?.message || 'Anthropic API error')

    const responseText = anthropicData.content[0].text.trim()
    const parsed = JSON.parse(responseText)

    // Save role interview to database
    const { data: interview, error: insertError } = await supabase
      .from('role_interviews')
      .insert({
        candidate_id,
        job_url,
        job_title: parsed.job_title || 'Role interview',
        company_name: parsed.company_name || '',
        question_1: parsed.questions[0],
        question_2: parsed.questions[1],
        question_3: parsed.questions[2],
      })
      .select()
      .single()

    if (insertError) throw insertError

    // Deduct one free interview if applicable
    const { data: cand } = await supabase
      .from('candidates')
      .select('role_interviews_remaining, role_interviews_unlimited_until')
      .eq('id', candidate_id)
      .single()

    const hasUnlimited = cand?.role_interviews_unlimited_until && new Date(cand.role_interviews_unlimited_until) > new Date()

    if (!hasUnlimited && cand?.role_interviews_remaining > 0) {
      await supabase
        .from('candidates')
        .update({ role_interviews_remaining: cand.role_interviews_remaining - 1 })
        .eq('id', candidate_id)
    }

    return new Response(
      JSON.stringify({
        success: true,
        interview_id: interview.id,
        job_title: parsed.job_title,
        company_name: parsed.company_name,
        questions: parsed.questions,
      }),
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
