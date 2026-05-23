import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

serve(async (req) => {
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_SERVICE_KEY = Deno.env.get('DB_SERVICE_ROLE_KEY')
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    const body = await req.text()
    const event = JSON.parse(body)

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const metadata = session.metadata || {}
      const priceId = metadata.price_id

      const PRICE_VIDEO = 'price_1Ta8LQAwK1Dmgw1KSotVsr79'
      const PRICE_ROLE_ADHOC = 'price_1Ta8O8AwK1Dmgw1K3k8t7bfV'
      const PRICE_ROLE_UNLIMITED = 'price_1Ta8QSAwK1Dmgw1KDx7y7ZV6'
      const PRICE_ROLE_RENEWAL = 'price_1Ta8bqAwK1Dmgw1KB21Ut4Hh'
      const PRICE_JOB = 'price_1Ta8SkAwK1Dmgw1KgMHJvGgG'
      const PRICE_PREMIUM = 'price_1Ta8TsAwK1Dmgw1KBS4wQeIe'
      const PRICE_BUNDLE = 'price_1Ta8VgAwK1Dmgw1K5dRBtKvd'

      if (priceId === PRICE_VIDEO) {
        await supabase.from('candidates').update({ has_paid: true, paid_at: new Date().toISOString(), stripe_customer_id: session.customer, role_interviews_remaining: 1 }).eq('id', metadata.candidate_id)
      } else if (priceId === PRICE_ROLE_ADHOC) {
        const { data: c } = await supabase.from('candidates').select('role_interviews_remaining').eq('id', metadata.candidate_id).single()
        await supabase.from('candidates').update({ role_interviews_remaining: (c?.role_interviews_remaining || 0) + 1 }).eq('id', metadata.candidate_id)
      } else if (priceId === PRICE_ROLE_UNLIMITED) {
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        await supabase.from('candidates').update({ role_interviews_unlimited_until: expiresAt }).eq('id', metadata.candidate_id)
      } else if (priceId === PRICE_ROLE_RENEWAL) {
        const { data: c } = await supabase.from('candidates').select('role_interviews_unlimited_until').eq('id', metadata.candidate_id).single()
        const current = c?.role_interviews_unlimited_until ? new Date(c.role_interviews_unlimited_until) : new Date()
        const newExpiry = new Date(Math.max(current.getTime(), Date.now()) + 30 * 24 * 60 * 60 * 1000).toISOString()
        await supabase.from('candidates').update({ role_interviews_unlimited_until: newExpiry }).eq('id', metadata.candidate_id)
      } else if ([PRICE_JOB, PRICE_PREMIUM, PRICE_BUNDLE].includes(priceId)) {
        await supabase.from('jobs').update({ is_active: true, stripe_payment_id: session.payment_intent }).eq('id', metadata.job_id)
        let unlocks = priceId === PRICE_PREMIUM ? 10 : priceId === PRICE_BUNDLE ? 100 : 0
        if (unlocks > 0) {
          const { data: emp } = await supabase.from('employers').select('ai_match_unlocks_remaining').eq('id', metadata.employer_id).single()
          await supabase.from('employers').update({ ai_match_unlocks_remaining: (emp?.ai_match_unlocks_remaining || 0) + unlocks }).eq('id', metadata.employer_id)
        }
      }
    }

    return new Response('ok', { status: 200 })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
