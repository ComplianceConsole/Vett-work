import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')
    const body = await req.json()
    const { price_id, product, candidate_id, candidate_ids, employer_id, job_id, quantity, allow_promotion_codes, success_url, cancel_url } = body

    const params = new URLSearchParams({
      'mode': 'payment',
      'line_items[0][price]': price_id,
      'line_items[0][quantity]': String(quantity || 1),
      'success_url': success_url || 'https://vett.work',
      'cancel_url': cancel_url || 'https://vett.work',
      'metadata[product]': product || '',
    })

    if (allow_promotion_codes) params.append('allow_promotion_codes', 'true')
    if (candidate_id) params.append('metadata[candidate_id]', candidate_id)
    if (candidate_ids) params.append('metadata[candidate_ids]', candidate_ids)
    if (employer_id) params.append('metadata[employer_id]', employer_id)
    if (job_id) params.append('metadata[job_id]', job_id)

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })

    const session = await stripeRes.json()
    if (!stripeRes.ok) throw new Error(session.error?.message || 'Stripe error')

    return new Response(JSON.stringify({ url: session.url }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
