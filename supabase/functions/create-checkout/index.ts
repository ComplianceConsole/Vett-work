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
    const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_SERVICE_KEY = Deno.env.get('DB_SERVICE_ROLE_KEY')

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const { price_id, product, candidate_id, employer_id, job_id, success_url, cancel_url } = await req.json()

    // Create Stripe checkout session
    const params = new URLSearchParams({
      'mode': 'payment',
      'line_items[0][price]': price_id,
      'line_items[0][quantity]': '1',
      'success_url': success_url || 'https://vett.work/candidate-dashboard.html?payment=success',
      'cancel_url': cancel_url || 'https://vett.work/candidate-dashboard.html?payment=cancelled',
      'metadata[price_id]': price_id,
      'metadata[product]': product || '',
    })

    if (candidate_id) params.append('metadata[candidate_id]', candidate_id)
    if (employer_id) params.append('metadata[employer_id]', employer_id)
    if (job_id) params.append('metadata[job_id]', job_id)

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })

    const session = await stripeRes.json()

    if (!stripeRes.ok) {
      throw new Error(session.error?.message || 'Stripe error')
    }

    return new Response(
      JSON.stringify({ url: session.url }),
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
