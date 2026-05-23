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

    const { candidate_id, regen_clip, current_question } = await req.json()

    if (!candidate_id) {
      return new Response(
        JSON.stringify({ error: 'Missing candidate_id' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { data: candidate, error: candError } = await supabase
      .from('candidates')
      .select('*')
      .eq('id', candidate_id)
      .single()

    if (candError || !candidate) {
      throw new Error('Candidate not found')
    }

    const cvContext = candidate.cv_text || `LinkedIn: ${candidate.linkedin_url}` || 'No CV provided'

    const clipTitles = [
      'Your Passion & Direction',
      'Work History',
      'Career Highlight',
      'Ideal Next Role',
      'Strengths',
      'Growth Area'
    ]

    const clipDescriptions = [
      'ask about their professional passions and what they are looking for in their next role',
      'reference their actual roles and career journey specifically',
      'pick ONE specific achievement, project or role from their CV and ask them to tell the story behind it',
      'ask what they would actually be doing day to day in their ideal role',
      'ask for a real example of what they do better than most people',
      'ask what they are actively working on improving and what they are doing about it'
    ]

    if (regen_clip !== undefined && regen_clip !== null) {
      const clipIndex = parseInt(regen_clip)
      const prompt = `You are generating a personalised video interview question for a job candidate.

Here is their background:
${cvContext}

You need to generate ONE new question for section ${clipIndex + 1}: "${clipTitles[clipIndex]}"
The question should: ${clipDescriptions[clipIndex]}

The previous question was: "${current_question}"
Generate a DIFFERENT question that covers the same theme but approaches it from a different angle.

Rules:
- Must be personalised to their actual background where possible
- Warm, conversational tone — not corporate
- 1-2 sentences max
- Must be different from the previous question
- Stay on the same theme as the section title

Return ONLY the question text, no quotes, no other text.`

      const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }]
        })
      })

      const anthropicData = await anthropicResponse.json()
      if (!anthropicResponse.ok) throw new Error(anthropicData.error?.message || 'Anthropic API error')

      const newQuestion = anthropicData.content[0].text.trim()
      const updatedPrompts = [...(candidate.ai_prompts || [])]
      updatedPrompts[clipIndex] = newQuestion

      await supabase.from('candidates').update({ ai_prompts: updatedPrompts }).eq('id', candidate_id)
      await supabase.from('candidate_clips').update({ ai_prompt: newQuestion }).eq('candidate_id', candidate_id).eq('clip_number', clipIndex + 1)

      return new Response(
        JSON.stringify({ success: true, prompts: updatedPrompts }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const prompt = `You are helping generate personalised video interview questions for a job candidate based on their CV or LinkedIn profile.

Here is their background:
${cvContext}

Generate exactly 6 interview questions for these sections:
1. Your Passion & Direction - ask about their professional passions and what they are looking for in their next role
2. Work History - reference their actual roles and career journey specifically
3. Career Highlight - pick ONE specific achievement, project or role from their CV and ask them to tell the story behind it
4. Ideal Next Role - ask what they would actually be doing day to day in their ideal role
5. Strengths - ask for a real example of what they do better than most people
6. Growth Area - ask what they are actively working on improving and what they are doing about it

Rules:
- Questions must be personalised to their actual background - reference real companies, roles or achievements where possible
- Write in a warm, conversational tone - not corporate
- Each question should be 1-2 sentences max
- Return ONLY a JSON array of 6 strings, no other text

Example format:
["Question 1", "Question 2", "Question 3", "Question 4", "Question 5", "Question 6"]`

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    })

    const anthropicData = await anthropicResponse.json()
    if (!anthropicResponse.ok) throw new Error(anthropicData.error?.message || 'Anthropic API error')

    const responseText = anthropicData.content[0].text.trim()
    const prompts = JSON.parse(responseText)

    if (!Array.isArray(prompts) || prompts.length !== 6) {
      throw new Error('Invalid prompts format returned')
    }

    await supabase.from('candidates').update({ ai_prompts: prompts }).eq('id', candidate_id)
    await supabase.from('candidate_clips').delete().eq('candidate_id', candidate_id)
    await supabase.from('candidate_clips').insert(
      prompts.map((p, i) => ({
        candidate_id,
        clip_number: i + 1,
        clip_title: clipTitles[i],
        ai_prompt: p,
        is_complete: false,
      }))
    )

    return new Response(
      JSON.stringify({ success: true, prompts }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
