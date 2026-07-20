import type { PrismaService } from '../prisma/prisma.service'

const GRAPH_BASE = 'https://graph.facebook.com/v18.0'
const BUCKET = 'voice-messages'

function mimeToExt(mime: string, fallbackType: string): string {
  if (mime.includes('ogg'))  return 'ogg'
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('png'))  return 'png'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('mp4'))  return 'mp4'
  if (mime.includes('pdf'))  return 'pdf'
  if (fallbackType === 'audio')    return 'ogg'
  if (fallbackType === 'image')    return 'jpg'
  if (fallbackType === 'video')    return 'mp4'
  if (fallbackType === 'document') return 'pdf'
  return 'bin'
}

/**
 * Download a Meta media file and store it in Supabase Storage.
 * Called fire-and-forget from the webhook — never throws to the caller.
 *
 * Requires env vars:
 *   SUPABASE_URL         https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_KEY service_role JWT from Supabase dashboard → Settings → API
 */
export async function captureMedia(
  prisma:    PrismaService,
  msgId:     string,
  mediaId:   string,
  waToken:   string,
  companyId: string,
  convId:    string,
  mediaType: string,
): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.warn('[MEDIA_CAPTURE] SUPABASE_URL or SUPABASE_SERVICE_KEY not set — skipping')
    return
  }

  // 1. Resolve temp download URL from Meta
  const metaRes = await fetch(`${GRAPH_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${waToken}` },
  })
  if (!metaRes.ok) {
    throw new Error(`Meta media lookup ${mediaId} → ${metaRes.status}: ${await metaRes.text()}`)
  }
  const { url: tempUrl, mime_type: mimeType = '' } = await metaRes.json() as {
    url: string
    mime_type?: string
  }

  // 2. Download the file (URL valid ~5 min)
  const fileRes = await fetch(tempUrl, {
    headers: { Authorization: `Bearer ${waToken}` },
  })
  if (!fileRes.ok) {
    throw new Error(`Media download failed ${mediaId} → ${fileRes.status}`)
  }
  const buffer = Buffer.from(await fileRes.arrayBuffer())

  // 3. Upload to Supabase Storage
  const ext  = mimeToExt(mimeType, mediaType)
  const path = `${companyId}/${convId}/${mediaType}-${Date.now()}.${ext}`
  const uploadRes = await fetch(
    `${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${supabaseKey}`,
        'Content-Type': mimeType || 'application/octet-stream',
        'x-upsert':     'true',
      },
      body: buffer,
    },
  )
  if (!uploadRes.ok) {
    throw new Error(`Supabase upload failed → ${uploadRes.status}: ${await uploadRes.text()}`)
  }

  // 4. Stamp the Message row with the permanent public URL
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`
  await prisma.message.update({
    where: { id: msgId },
    data:  { mediaUrl: publicUrl, mediaType },
  })
  console.log(`[MEDIA_CAPTURE] ${mediaType} stored — msg=${msgId} url=${publicUrl}`)
}
