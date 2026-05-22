import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

serve(async (req) => {
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_SERVICE_KEY = Deno.env.get('DB_SERVICE_ROLE_KEY')
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    const payload = await req.json()
    const eventType = payload.type

    // Only handle asset ready events
    if (eventType !== 'video.asset.ready') {
      return new Response('ok', { status: 200 })
    }

    const asset = payload.data
    const passthrough = asset.passthrough ? JSON.parse(asset.passthrough) : null

    if (!passthrough?.candidate_id || !passthrough?.clip_number) {
      return new Response('missing passthrough', { status: 400 })
    }

    const playbackId = asset.playback_ids?.[0]?.id
    const assetId = asset.id

    if (!playbackId) {
      return new Response('no playback id', { status: 400 })
    }

    // Update the clip with Mux playback ID
    const { error } = await supabase
      .from('candidate_clips')
      .update({
        mux_asset_id: assetId,
        mux_playback_id: playbackId,
        thumbnail_url: `https://image.mux.com/${playbackId}/thumbnail.jpg`,
      })
      .eq('candidate_id', passthrough.candidate_id)
      .eq('clip_number', passthrough.clip_number)

    if (error) throw error

    return new Response('ok', { status: 200 })

  } catch (err) {
    console.error(err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
