import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SUPABASE_SERVICE_KEY = Deno.env.get('DB_SERVICE_ROLE_KEY')!
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!
    const INGEST_API_KEY = Deno.env.get('JOB_INGEST_API_KEY')

    const apiKey = req.headers.get('x-api-key')
    if (apiKey !== INGEST_API_KEY) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), { status: 401, headers: corsHeaders })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Get all saved searches
    const { data: searches } = await supabase
      .from('saved_searches')
      .select('*, candidates(id, first_name, last_name, user_id)')

    if (!searches?.length) {
      return new Response(JSON.stringify({ success: true, notified: 0 }), { headers: corsHeaders })
    }

    // Get jobs from last 24 hours
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: newJobs } = await supabase
      .from('jobs')
      .select('id, title, location, category, employment_type, work_type, salary_range, employers(company_name)')
      .eq('is_active', true)
      .gte('created_at', since)

    if (!newJobs?.length) {
      return new Response(JSON.stringify({ success: true, notified: 0, message: 'No new jobs' }), { headers: corsHeaders })
    }

    let notified = 0

    for (const search of searches) {
      const cand = search.candidates
      if (!cand) continue

      // Get candidate email from auth
      const { data: { users } } = await supabase.auth.admin.listUsers()
      const authUser = users?.find(u => u.id === cand.user_id)
      if (!authUser?.email) continue

      // Match jobs against this search
      const matched = newJobs.filter(job => {
        const matchKeyword = !search.keyword ||
          job.title.toLowerCase().includes(search.keyword.toLowerCase()) ||
          (job.employers?.company_name || '').toLowerCase().includes(search.keyword.toLowerCase())
        const matchLocation = !search.location ||
          (job.location || '').toLowerCase().includes(search.location.toLowerCase())
        const matchCategory = !search.categories?.length ||
          search.categories.includes(job.category)
        const matchWorkType = !search.work_types?.length ||
          search.work_types.includes(job.employment_type) ||
          search.work_types.includes(job.work_type)

        return matchKeyword && matchLocation && matchCategory && matchWorkType
      })

      if (matched.length === 0) continue

      // Send email
      const name = cand.first_name || 'there'
      const jobRows = matched.slice(0, 5).map(j => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #f1f5f9">
            <div style="font-size:14px;font-weight:700;color:#0c1445">${j.title}</div>
            <div style="font-size:12px;color:#64748b;margin-top:2px">${j.employers?.company_name || ''} · ${j.location || ''}</div>
          </td>
          <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;text-align:right;white-space:nowrap">
            <a href="https://vett.work/job.html?id=${j.id}" style="font-size:12px;font-weight:700;color:#10b981;text-decoration:none">View role →</a>
          </td>
        </tr>`).join('')

      const moreText = matched.length > 5
        ? `<p style="font-size:13px;color:#64748b;text-align:center;margin-top:16px">+${matched.length - 5} more matching roles on vett.work</p>`
        : ''

      const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8fafc;font-family:'Plus Jakarta Sans',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
  <tr><td style="background:#0c1445;border-radius:14px 14px 0 0;padding:24px 36px">
    <span style="font-size:20px;font-weight:800;color:white"><span style="color:#10b981">vett</span>.work</span>
  </td></tr>
  <tr><td style="background:white;padding:32px 36px">
    <p style="font-size:16px;font-weight:700;color:#0c1445;margin:0 0 8px">Hi ${name} — ${matched.length} new ${matched.length === 1 ? 'role' : 'roles'} match your saved search</p>
    <p style="font-size:13px;color:#64748b;margin:0 0 24px">Search: <strong>${search.name}</strong></p>
    <table width="100%" cellpadding="0" cellspacing="0">${jobRows}</table>
    ${moreText}
    <div style="text-align:center;margin-top:24px">
      <a href="https://vett.work?q=${encodeURIComponent(search.keyword||'')}&l=${encodeURIComponent(search.location||'')}" style="display:inline-block;background:#10b981;color:white;font-size:14px;font-weight:700;padding:12px 28px;border-radius:10px;text-decoration:none">See all matching roles →</a>
    </div>
  </td></tr>
  <tr><td style="background:#0c1445;border-radius:0 0 14px 14px;padding:16px 36px">
    <p style="font-size:11px;color:rgba(255,255,255,0.35);margin:0">You're receiving this because you saved a search on <a href="https://vett.work" style="color:#10b981;text-decoration:none">vett.work</a>. <a href="https://vett.work/candidate-dashboard.html" style="color:rgba(255,255,255,0.4);text-decoration:none">Manage saved searches</a></p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'vett.work <hello@vett.work>',
          to: [authUser.email],
          subject: `${matched.length} new ${matched.length === 1 ? 'role matches' : 'roles match'} your search — ${search.name}`,
          html,
        })
      })

      // Update last notified
      await supabase.from('saved_searches')
        .update({ last_notified_at: new Date().toISOString(), new_jobs_count: matched.length })
        .eq('id', search.id)

      notified++
    }

    return new Response(JSON.stringify({ success: true, notified }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
