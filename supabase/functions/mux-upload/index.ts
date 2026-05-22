import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const MUX_TOKEN_ID = Deno.env.get('MUX_TOKEN_ID')
    const MUX_TOKEN_SECRET = Deno.env.get('MUX_TOKEN_SECRET')

    const { candidate_id, clip_number } = await req.json()

    if (!candidate_id || !clip_number) {
      return new Response(
        JSON.stringify({ error: 'Missing candidate_id or clip_number' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Create a Mux direct upload URL
    const muxResponse = await fetch('https://api.mux.com/video/v1/uploads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + btoa(`${MUX_TOKEN_ID}:${MUX_TOKEN_SECRET}`),
      },
      body: JSON.stringify({
        cors_origin: '*',
        new_asset_settings: {
          playback_policy: ['signed'],
          passthrough: JSON.stringify({ candidate_id, clip_number }),
        },
      }),
    })

    const muxData = await muxResponse.json()

    if (!muxResponse.ok) {
      throw new Error(muxData.error?.messages?.[0] || 'Mux API error')
    }

    return new Response(
      JSON.stringify({
        upload_id: muxData.data.id,
        upload_url: muxData.data.url,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
