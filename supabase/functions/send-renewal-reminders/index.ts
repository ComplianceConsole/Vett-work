import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

serve(async (req) => {
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_SERVICE_KEY = Deno.env.get('DB_SERVICE_ROLE_KEY')
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    const now = new Date()

    // Find candidates expiring in 7 days (day 23)
    const day23 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    const day23Start = new Date(day23); day23Start.setHours(0,0,0,0)
    const day23End = new Date(day23); day23End.setHours(23,59,59,999)

    // Find candidates expiring tomorrow (day 29)
    const day29 = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000)
    const day29Start = new Date(day29); day29Start.setHours(0,0,0,0)
    const day29End = new Date(day29); day29End.setHours(23,59,59,999)

    const { data: week7 } = await supabase
      .from('candidates')
      .select('id, email, first_name, role_interviews_unlimited_until')
      .gte('role_interviews_unlimited_until', day23Start.toISOString())
      .lte('role_interviews_unlimited_until', day23End.toISOString())

    const { data: day1 } = await supabase
      .from('candidates')
      .select('id, email, first_name, role_interviews_unlimited_until')
      .gte('role_interviews_unlimited_until', day29Start.toISOString())
      .lte('role_interviews_unlimited_until', day29End.toISOString())

    // Send emails via Supabase Auth email or a simple fetch to Resend
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')

    async function sendEmail(to: string, name: string, type: '7day' | '1day') {
      const subject = type === '7day'
        ? 'Your unlimited role interviews expire in 7 days'
        : 'Last chance — your unlimited role interviews expire tomorrow'

      const body = type === '7day'
        ? `Hi ${name || 'there'},\n\nJust a heads up — your unlimited role-specific interviews expire in 7 days.\n\nStill on the hunt? Roll over for another month for just $50.\n\nhttps://vett.work/candidate-dashboard.html\n\nGood luck out there.\n\nThe vett.work team`
        : `Hi ${name || 'there'},\n\nYour unlimited role-specific interviews expire tomorrow.\n\nDon't lose your momentum — roll over for another month for just $50.\n\nhttps://vett.work/candidate-dashboard.html\n\nThe vett.work team`

      if (RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'vett.work <hello@vett.work>',
            to,
            subject,
            text: body,
          })
        })
      }
    }

    for (const c of (week7 || [])) {
      await sendEmail(c.email, c.first_name, '7day')
    }

    for (const c of (day1 || [])) {
      await sendEmail(c.email, c.first_name, '1day')
    }

    return new Response(JSON.stringify({
      sent_7day: week7?.length || 0,
      sent_1day: day1?.length || 0,
    }), { status: 200 })

  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
