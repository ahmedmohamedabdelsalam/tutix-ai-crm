import { PrismaService } from '../prisma/prisma.service'
import { GRAPH_VERSION } from './graph-api'

/**
 * Meta media IDs, cached on the SAME MediaAsset table the dashboard's brochure
 * sending uses — one cache, not two.
 *
 * A second table would drift: two TTLs, two eviction rules, and two chances to hand
 * Meta an ID that expired last week. The cache key is (companyId, checksum) and is
 * never shared across companies — the same rule as the Stage 1 image work. Two
 * companies uploading a byte-identical file still get their own media ID, because a
 * media ID belongs to the phone number that uploaded it and reusing one across
 * tenants would send Meta another company's asset.
 */

const TTL_DAYS = 25          // Meta expires media at 30 days; stop well short of it.

export interface CachedMedia { mediaId: string }

/**
 * A usable media ID, or null.
 *
 * Re-checks the stored waPhoneId, because a media ID is scoped to the number that
 * uploaded it. If the company's number changed, the cached ID would be rejected by
 * Meta at send time — so it is dropped here rather than discovered later.
 */
export async function findCachedMediaId(
  prisma: PrismaService,
  companyId: string,
  checksum: string,
  waPhoneId: string,
): Promise<string | null> {
  try {
    const row = await prisma.mediaAsset.findFirst({ where: { companyId, checksum } })
    if (!row) return null
    if (row.waPhoneId !== waPhoneId || row.expiresAt < new Date()) {
      await prisma.mediaAsset.delete({ where: { id: row.id } }).catch(() => {})
      return null
    }
    return row.mediaId
  } catch (e) {
    // A cache is an optimisation. If it errors, upload again — never fail the send.
    console.error(`[MEDIA_CACHE_READ_FAILED] ${(e as Error).message}`)
    return null
  }
}

export async function cacheMediaId(
  prisma: PrismaService,
  companyId: string,
  checksum: string,
  waPhoneId: string,
  mediaId: string,
  mime: string,
  bytes: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000)
  try {
    await prisma.mediaAsset.upsert({
      where: { companyId_checksum: { companyId, checksum } },
      create: { companyId, checksum, mediaId, waPhoneId, mime, bytes, expiresAt },
      update: { mediaId, waPhoneId, mime, bytes, expiresAt },
    })
    console.log(`[MEDIA_CACHE_STORE] company=${companyId} checksum=${checksum.slice(0, 12)} media=${mediaId}`)
  } catch (e) {
    console.error(`[MEDIA_CACHE_STORE_FAILED] ${(e as Error).message}`)
  }
}

/**
 * Fetch the image bytes and hand them to Meta, returning a media ID.
 *
 * The media endpoint cannot ingest a URL — only bytes — so the file is pulled from
 * storage here first. Failures return null and the caller drops the image; nothing
 * in this path may take the text reply down with it.
 */
export async function uploadImageToMeta(
  waPhoneId: string,
  waToken: string,
  url: string,
  mime: string,
): Promise<{ mediaId: string; bytes: number } | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.error(`[IMAGE_FETCH_FAILED] ${res.status} ${url.slice(0, 120)}`)
      return null
    }
    const buffer = Buffer.from(await res.arrayBuffer())

    const form = new FormData()
    form.append('messaging_product', 'whatsapp')
    form.append('type', mime)
    form.append('file', new Blob([new Uint8Array(buffer)], { type: mime }), `programme.${mime === 'image/png' ? 'png' : 'jpg'}`)

    const up = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${waPhoneId}/media`, {
      method: 'POST', headers: { Authorization: `Bearer ${waToken}` }, body: form,
    })
    const body = await up.text()
    if (!up.ok) {
      // Full body, never a summary — a truncated Meta error is how the brochure
      // failure went undiagnosed for days.
      console.error(`[IMAGE_UPLOAD_FAILED] status=${up.status} — Meta said: ${body}`)
      return null
    }
    const id = (JSON.parse(body) as { id?: string }).id
    return id ? { mediaId: id, bytes: buffer.length } : null
  } catch (e) {
    console.error(`[IMAGE_UPLOAD_FAILED] ${(e as Error).message}`)
    return null
  }
}
