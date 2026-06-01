import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.38/deno-dom-wasm.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function cleanText(str: string): string {
  return (str || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/?(p|div|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { job_id } = await req.json()
    if (!job_id) return new Response(JSON.stringify({ error: 'job_id required' }), { status: 400, headers: corsHeaders })

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SUPABASE_SERVICE_KEY = Deno.env.get('DB_SERVICE_ROLE_KEY')!
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Get the job
    const { data: job } = await supabase
      .from('jobs')
      .select('id, title, description, application_url, source')
      .eq('id', job_id)
      .single()

    if (!job) return new Response(JSON.stringify({ error: 'Job not found' }), { status: 404, headers: corsHeaders })

    // If already has a long description, return it
    if ((job.description || '').length > 500) {
      return new Response(JSON.stringify({ success: true, description: job.description, cached: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Only fetch for jora jobs with a URL
    if (!job.application_url || job.source !== 'jora') {
      return new Response(JSON.stringify({ success: false, reason: 'Not a fetchable source' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Fetch the Jora detail page
    const res = await fetch(job.application_url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-AU,en;q=0.9',
        'Cache-Control': 'no-cache',
      }
    })

    if (!res.ok) {
      return new Response(JSON.stringify({ success: false, reason: `HTTP ${res.status}` }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const html = await res.text()
    const doc = new DOMParser().parseFromString(html, 'text/html')
    if (!doc) return new Response(JSON.stringify({ success: false, reason: 'Parse failed' }), { headers: corsHeaders })

    // Try multiple selectors
    const selectors = [
      '.job-description-container',
      '.job-description',
      '[class*="job-description"]',
      '.description',
      '[class*="description-content"]',
    ]

    let fullDesc = ''
    for (const sel of selectors) {
      const el = doc.querySelector(sel)
      if (el) {
        const text = cleanText(el.innerHTML || el.textContent || '')
        if (text.length > 200) {
          fullDesc = text
          break
        }
      }
    }

    if (!fullDesc || fullDesc.length < 200) {
      return new Response(JSON.stringify({ success: false, reason: 'Description too short after extraction' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Also extract email if present
    const emailMatch = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i)
    const email = emailMatch?.[1]?.toLowerCase()
    const appEmail = email && !email.includes('jora.') ? email : null

    // Update the job in DB
    const updateData: any = { description: fullDesc }
    if (appEmail) updateData.application_email = appEmail

    await supabase.from('jobs').update(updateData).eq('id', job_id)

    return new Response(JSON.stringify({ success: true, description: fullDesc, email: appEmail }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
