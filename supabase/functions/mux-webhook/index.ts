import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

serve(async (req) => {
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_SERVICE_KEY = Deno.env.get('DB_SERVICE_ROLE_KEY')
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    const payload = await req.json()
    if (payload.type !== 'video.asset.ready') return new Response('ok', { status: 200 })

    const asset = payload.data
    const passthrough = asset.passthrough ? JSON.parse(asset.passthrough) : null
    if (!passthrough?.candidate_id || !passthrough?.clip_number) return new Response('missing passthrough', { status: 400 })

    const playbackId = asset.playback_ids?.[0]?.id
    if (!playbackId) return new Response('no playback id', { status: 400 })

    await supabase.from('candidate_clips').update({
      mux_asset_id: asset.id,
      mux_playback_id: playbackId,
      thumbnail_url: `https://image.mux.com/${playbackId}/thumbnail.jpg`,
      is_complete: true,
    }).eq('candidate_id', passthrough.candidate_id).eq('clip_number', passthrough.clip_number)

    const { data: clips } = await supabase.from('candidate_clips').select('clip_number').eq('candidate_id', passthrough.candidate_id).eq('is_complete', true)
    const completedCount = clips?.length || 0

    if (completedCount === 6) {
      const { data: candidate } = await supabase.from('candidates').select('email, first_name, role_interviews_remaining').eq('id', passthrough.candidate_id).single()

      if (candidate?.email) {
        if (!candidate.role_interviews_remaining || candidate.role_interviews_remaining === 0) {
          await supabase.from('candidates').update({ role_interviews_remaining: 1 }).eq('id', passthrough.candidate_id)
        }

        if (RESEND_API_KEY) {
          const firstName = candidate.first_name || 'there'
          const emailHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;background:#f8fafc}.header{background:#0c1445;padding:28px 32px;border-radius:12px 12px 0 0}.logo{font-size:20px;font-weight:800;color:white;letter-spacing:-0.5px}.logo span{color:#10b981}.body{background:white;padding:32px}.title{font-size:24px;font-weight:800;color:#0c1445;letter-spacing:-0.5px;margin-bottom:12px;line-height:1.1}.body p{font-size:15px;color:#64748b;line-height:1.7;margin-bottom:16px}.bonus-card{background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:20px 24px;margin:24px 0}.bonus-label{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;color:#059669;margin-bottom:8px}.bonus-title{font-size:16px;font-weight:700;color:#0c1445;margin-bottom:6px}.bonus-sub{font-size:13px;color:#64748b;line-height:1.55}.cta{display:block;background:#10b981;color:white;font-weight:700;font-size:15px;padding:15px 28px;border-radius:10px;text-decoration:none;text-align:center;margin-top:24px}.footer{background:#0c1445;padding:20px 32px;border-radius:0 0 12px 12px;font-size:12px;color:rgba(255,255,255,0.3)}</style></head><body><div class="header"><div class="logo">vett<span>.</span>work</div></div><div class="body"><div class="title">Your virtual interview is complete, ${firstName}.</div><p>All 6 answers recorded. Your profile is ready — attach the link to any application, or opt in to the candidate database and let employers find you.</p><p>You've done the hard part. Most candidates never get this far.</p><div class="bonus-card"><div class="bonus-label">🎁 Your bonus — unlocked</div><div class="bonus-title">One free role-specific interview</div><div class="bonus-sub">Paste any job ad URL and we'll write 3 interview questions tailored to that exact role and your background. Record your answers and attach directly to that application.</div></div><p>Your free role-specific interview is waiting in your dashboard.</p><a href="https://vett.work/candidate-dashboard.html" class="cta">Go to my dashboard →</a></div><div class="footer">vett.work · Sent because you completed your virtual interview</div></body></html>`

          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: 'vett.work <hello@vett.work>', to: candidate.email, subject: `Your virtual interview is complete — here's your bonus, ${firstName}`, html: emailHtml }),
          })
        }
      }
    }

    return new Response('ok', { status: 200 })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
