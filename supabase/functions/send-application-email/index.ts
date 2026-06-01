import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const {
      to,
      candidateName,
      candidateEmail,
      candidateHeadline,
      candidateLocation,
      profileUrl,
      jobTitle,
      companyName,
      coverNote,
    } = await req.json()

    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
    if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set')

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Plus Jakarta Sans',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

  <!-- Header -->
  <tr><td style="background:#0c1445;border-radius:14px 14px 0 0;padding:28px 36px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td>
          <span style="font-size:22px;font-weight:800;color:white;letter-spacing:-0.5px">
            <span style="color:#10b981">vett</span>.work
          </span>
        </td>
        <td align="right" style="font-size:12px;color:rgba(255,255,255,0.4)">Job application</td>
      </tr>
    </table>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:white;padding:36px">

    <p style="font-size:15px;color:#0f172a;margin:0 0 6px;font-weight:600">Hi ${companyName},</p>
    <p style="font-size:14px;color:#475569;margin:0 0 24px;line-height:1.6">
      You have a new application for <strong>${jobTitle}</strong>.
    </p>

    <!-- Candidate card -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;margin-bottom:24px">
      <tr><td style="padding:20px 24px">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="width:52px;vertical-align:top">
              <div style="width:48px;height:48px;border-radius:50%;background:#10b981;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:white;text-align:center;line-height:48px">
                ${(candidateName || '?').split(' ').map((w: string) => w[0]).join('').substring(0,2).toUpperCase()}
              </div>
            </td>
            <td style="padding-left:14px;vertical-align:top">
              <div style="font-size:16px;font-weight:800;color:#0c1445;margin-bottom:2px">${candidateName}</div>
              ${candidateHeadline ? `<div style="font-size:13px;color:#475569;margin-bottom:2px">${candidateHeadline}</div>` : ''}
              ${candidateLocation ? `<div style="font-size:12px;color:#94a3b8">${candidateLocation}</div>` : ''}
            </td>
          </tr>
        </table>
      </td></tr>
    </table>

    ${coverNote ? `
    <!-- Personal note -->
    <div style="background:#f0fdf4;border-left:3px solid #10b981;padding:14px 18px;border-radius:0 8px 8px 0;margin-bottom:24px">
      <div style="font-size:11px;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Personal note</div>
      <p style="font-size:14px;color:#0f172a;margin:0;line-height:1.65">${coverNote}</p>
    </div>
    ` : ''}

    <!-- CTA -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr>
        <td align="center">
          <a href="${profileUrl}" style="display:inline-block;background:#10b981;color:white;font-size:14px;font-weight:700;padding:14px 32px;border-radius:10px;text-decoration:none;letter-spacing:-0.2px">
            View full profile &amp; virtual interview →
          </a>
        </td>
      </tr>
    </table>

    <p style="font-size:12px;color:#94a3b8;margin:0;text-align:center">
      Or copy this link: <a href="${profileUrl}" style="color:#10b981">${profileUrl}</a>
    </p>

  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#0c1445;border-radius:0 0 14px 14px;padding:20px 36px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="font-size:12px;color:rgba(255,255,255,0.35);line-height:1.6">
          This application was submitted via <strong style="color:rgba(255,255,255,0.6)">vett.work</strong> — where candidates record a virtual interview so you can see who they are before you call.<br>
          <a href="https://vett.work/employer-auth.html" style="color:#10b981;text-decoration:none">Create a free employer account</a> to post roles and browse candidates directly.
        </td>
        <td align="right" style="vertical-align:top">
          <span style="font-size:16px;font-weight:800;color:white;letter-spacing:-0.5px">
            <span style="color:#10b981">vett</span>.work
          </span>
        </td>
      </tr>
    </table>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'vett.work <hello@vett.work>',
        to: [to],
        reply_to: candidateEmail,
        subject: `Application: ${candidateName} for ${jobTitle}`,
        html,
      })
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Resend error: ${err}`)
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
