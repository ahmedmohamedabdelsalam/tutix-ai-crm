import type { ProgrammeImage } from './programme-images'

/**
 * What a handler returns — Stage 2 widened it from a string to "text, and possibly
 * a picture".
 *
 * Widened rather than replaced on purpose. Dozens of handlers return a bare string
 * and every one of them still means exactly what it meant before; making them all
 * construct an object would have been a large diff across code whose behaviour must
 * not change. The new shape is opt-in: only a handler that has decided an image is
 * safe ever builds one.
 */

export interface OutboundImage {
  url: string
  mime: string
  checksum: string
  /** Rides on the image and cannot be regenerated — carries the name, never a price. */
  caption: string
}

export interface RichReply {
  replies: string[]
  images: OutboundImage[]
}

export type HandleResult = string | string[] | RichReply

/**
 * Where handleMessage reports the row ids it persisted — one group per reply, each
 * group ordered by message part.
 *
 * An out-parameter rather than a return value on purpose: handleMessage returns from
 * roughly thirty places, and every one of them still returns exactly what it did
 * before. Threading ids through the return type would have meant touching all of
 * them, which is a large diff across code whose behaviour must not change.
 */
export interface PersistedRowSink {
  idGroups: string[][]
}

export function isRichReply(r: unknown): r is RichReply {
  return !!r && typeof r === 'object' && Array.isArray((r as RichReply).replies)
}

/** One shape for every caller, so no send path has to know which form it got. */
export function normalizeResult(result: HandleResult | null | undefined): RichReply {
  if (!result) return { replies: [], images: [] }
  if (typeof result === 'string') return { replies: result ? [result] : [], images: [] }
  if (Array.isArray(result)) return { replies: result.filter(Boolean), images: [] }
  return { replies: result.replies.filter(Boolean), images: result.images ?? [] }
}

/** Build the attachment for an image already judged safe to send. */
export function toOutboundImage(img: ProgrammeImage, caption: string): OutboundImage {
  return { url: img.url, mime: img.mime, checksum: img.checksum, caption }
}
