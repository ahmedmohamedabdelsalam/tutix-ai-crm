import { Controller, Get, Post, Body, Query, Res, Req, Headers, ForbiddenException } from '@nestjs/common'
import type { RawBodyRequest } from '@nestjs/common'
import type { Request, Response } from 'express'
import { ConvStatus } from '@prisma/client'
import { WhatsAppService } from './whatsapp.service'
import { FollowUpService } from './followup.service'
import { PrismaService } from '../prisma/prisma.service'
import { splitIntoMessages } from './message-splitter'
import { metaPost, sendWhatsAppMessage, sendWhatsAppImage } from './send-message'
import { normalizeResult, type PersistedRowSink } from './reply-shape'
import { findCachedMediaId, cacheMediaId, uploadImageToMeta } from './media-cache'
import { extractBsuid, linkBsuid, recordUnidentifiedInbound } from './bsuid'
import { findConversation, findLead, extractProfileName } from './identity'
import { captureMedia } from './capture-media'
import { isAIConfigActive, getAIConfigTemplates } from './ai-config-cache'
import { buildHandoffMessage } from './confidence-router'
import { logHandoff } from './handoff-log'
import { invalidateCatalogCache } from './catalog-loader'
import { assertInternalToken, checkMetaSignature } from './internal-auth'
import { optionalLookupKey } from './query-guard'
import { applyStatuses } from './status-webhook'
import { stampParts } from './stamp-parts'

const MEDIA_REPLIES: Record<string, { label: string; reply: string }> = {
  audio:    { label: '[رسالة صوتية]',   reply: 'حضرتك بعتلنا رسالة صوتية، للأسف مش بنقدر نسمعها دلوقتي لو ممكن تكتب طلبك يافندم نكون شاكرين' },
  sticker:  { label: '[استيكر]',        reply: 'ممكن تكتب طلبك أو سؤالك يافندم' },
  image:    { label: '[صورة]',           reply: 'ممكن تكتب لنا التفاصيل اللي حابب تستفسر عنها يافندم وفريقنا هيتابع مع حضرتك في حالة وجود أي إجراء مطلوب' },
  video:    { label: '[فيديو]',          reply: 'ممكن تكتب طلبك أو سؤالك يافندم' },
  document: { label: '[ملف]',           reply: 'ممكن تكتب طلبك أو سؤالك يافندم' },
}
const MEDIA_TYPES = new Set(Object.keys(MEDIA_REPLIES))

// Dedup guard: Meta sometimes delivers the same webhook twice within seconds.
// Keep the last 200 message IDs with their arrival timestamp; evict entries
// older than 5 minutes so memory stays bounded under sustained traffic.
const SEEN_MSG_TTL_MS = 5 * 60 * 1000   // 5 minutes
const SEEN_MSG_MAX    = 200
const seenMessageIds  = new Map<string, number>() // id → timestamp

function isDuplicateMessage(id: string): boolean {
  const now = Date.now()

  // Evict stale entries to keep the map bounded
  if (seenMessageIds.size >= SEEN_MSG_MAX) {
    for (const [k, ts] of seenMessageIds) {
      if (now - ts > SEEN_MSG_TTL_MS) seenMessageIds.delete(k)
    }
  }

  if (seenMessageIds.has(id)) return true
  seenMessageIds.set(id, now)
  return false
}

/** Count of unidentifiable inbound messages since boot — reported in each alarm. */
let noIdentityCount = 0

/**
 * Describe an unidentifiable payload by SHAPE ONLY — never its contents.
 *
 * This exists to answer one question from log data alone: are business-scoped
 * user IDs already arriving, and what does the payload look like when they do?
 * Key names and types answer that. Values do not, and the message body of a
 * customer we could not identify is the last thing that belongs in a log line.
 */
function describePayloadShape(
  message: Record<string, unknown> | undefined,
  contact: Record<string, unknown> | undefined,
): string {
  const keys = (o: Record<string, unknown> | undefined) =>
    o ? Object.keys(o).sort().join(',') : '(absent)'
  const type = typeof message?.type === 'string' ? sanitiseToken(message.type as string) : '(none)'
  return [
    `messageKeys=[${keys(message)}]`,
    `type=${type}`,
    `contactKeys=[${keys(contact)}]`,
    `user_id=${describeBsuid(contact?.user_id)}`,
    `wa_id=${typeof contact?.wa_id === 'string' ? 'present' : 'absent'}`,
  ].join(' | ')
}

/**
 * A business-scoped user ID reduced to its shape: country-code prefix and length.
 *
 * Enough to confirm arrival and the documented "<CC>.<alnum>" format without
 * writing a stable per-user identifier into logs. We already log full phone
 * numbers on the normal path, so emitting the whole BSUID would not be
 * inconsistent — but it is not needed to answer the question this logging exists
 * for, and the narrower thing is the easier one to widen later if it is.
 */
function describeBsuid(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) return 'absent'
  const dot = v.indexOf('.')
  const cc = dot > 0 ? sanitiseToken(v.slice(0, dot)) : '?'
  return `present(cc=${cc},len=${v.length})`
}

/** Strip anything that could forge a log marker or break a line. Untrusted input. */
function sanitiseToken(v: string, max = 24): string {
  return v.replace(/[\r\n\[\]|]/g, '').trim().slice(0, max)
}

function detectAdSource(referral?: { source_url?: string }): string {
  if (!referral) return 'direct'
  const url = referral.source_url ?? ''
  if (url.includes('instagram.com')) return 'instagram'
  if (url.includes('tiktok.com')) return 'tiktok'
  // facebook.com, fb.com, or any other Meta ad — default to facebook
  return 'facebook'
}

@Controller('webhook')
export class WhatsAppController {
  constructor(
    private whatsapp: WhatsAppService,
    private followup: FollowUpService,
    private prisma: PrismaService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', ts: new Date().toISOString() }
  }

  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).send(challenge)
    }
    return res.status(403).send('Forbidden')
  }

  @Post()
  async receive(
    @Body() body: any,
    @Res() res: Response,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature?: string,
  ) {
    // Verify Meta's HMAC BEFORE returning 200 or doing any work. Under enforcement
    // an unsigned or forged payload must never reach handleMessage — that path
    // writes Lead / Conversation / Message rows, calls the model, and sends
    // WhatsApp messages from the company's number to an attacker-controlled `from`.
    //
    // Ships in WARN mode (META_SIGNATURE_ENFORCE unset): the outcome is logged but
    // the request is still processed, so a misconfigured secret cannot cut off live
    // customer traffic. Nothing below this block runs when accept is false.
    //
    // The context below feeds [SIG_REJECT_ALARM] under enforcement. Every field is
    // read from an UNVERIFIED request, so it is treated as untrusted and sanitised
    // before logging. Railway sits behind a proxy, so the client IP comes from
    // x-forwarded-for (first hop) with req.ip as the fallback.
    const fwd = (req.headers?.['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    const sig = checkMetaSignature(req.rawBody, signature, {
      ip:          fwd || req.ip || req.socket?.remoteAddress,
      payloadType: body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.type,
      objectType:  body?.object,
      bodyBytes:   req.rawBody?.length ?? 0,
    })
    if (!sig.accept) {
      console.warn(`WEBHOOK_SIG_REJECT — ${sig.reason}`)
      res.status(403).send('Forbidden')
      return
    }

    // Must return 200 to Meta immediately before any async work
    res.status(200).send('OK')
    try {
      const value   = body?.entry?.[0]?.changes?.[0]?.value
      const message = value?.messages?.[0]
      const contact = value?.contacts?.[0] as Record<string, unknown> | undefined

      // ── STATUS WEBHOOK ────────────────────────────────────────────────────
      // Roughly 4 in 5 of everything Meta sends us, and until now dropped on the
      // floor. It carries the only evidence we ever get that a message actually
      // reached the customer — or did not: a `failed` status is someone who never
      // received what we sent, which nothing anywhere recorded.
      //
      // Routed by waPhoneId like the message path, so one tenant's statuses can
      // never touch another's rows. 200 has already been sent; nothing in here may
      // throw, because Meta retries an errored webhook and we would amplify it.
      if (!message) {
        const statuses = value?.statuses
        if (Array.isArray(statuses) && statuses.length) {
          const statusPhoneId = value?.metadata?.phone_number_id
          const statusCompany = statusPhoneId
            ? await this.prisma.company.findFirst({
                where: { waPhoneId: statusPhoneId, isActive: true },
                select: { id: true },
              })
            : null
          if (statusCompany) {
            await applyStatuses(this.prisma, statusCompany.id, statuses)
          } else {
            console.warn(`[STATUS_NO_COMPANY] waPhoneId=${statusPhoneId ?? 'absent'} — ${statuses.length} status(es) dropped`)
          }
        }
        return
      }

      // Phase 1 captured this; Phase 3b makes it an identity in its own right.
      const bsuid = extractBsuid(value)
      const profileName = extractProfileName(value)

      // ── IDENTITY GUARD ────────────────────────────────────────────────────
      // Phase 3b: a message with ONLY a BSUID is now processable — it creates a
      // real conversation that appears in the sales inbox. What still cannot be
      // handled is a message with no identity at all, or no message id (which the
      // dedup claim depends on).
      //
      // Before 3b this branch caught every username-adopting customer and they were
      // simply lost. It now catches only genuinely unusable payloads, so a row here
      // should become rare — and each one is still recorded durably rather than
      // vanishing with the container.
      if (!message.id || (!message.from && !bsuid)) {
        noIdentityCount++
        await recordUnidentifiedInbound(this.prisma, {
          waPhoneId:   value?.metadata?.phone_number_id ?? null,
          waUserId:    bsuid,
          wamid:       typeof message.id === 'string' ? message.id : null,
          messageType: typeof message.type === 'string' ? sanitiseToken(message.type) : null,
          messageKeys: Object.keys(message).sort().join(','),
          contactKeys: contact ? Object.keys(contact).sort().join(',') : null,
          hasWaId:     typeof contact?.wa_id === 'string',
          reason:      !message.id ? 'no_message_id' : 'no_identity',
        })
        console.error(
          `[WEBHOOK_NO_IDENTITY] a customer message could not be identified and was NOT processed ` +
          `— occurrence=${noIdentityCount} since boot | ${describePayloadShape(message, contact)} | ` +
          `UNREACHABLE: this customer cannot be replied to or seen ANYWHERE. This number is Cloud-API ` +
          `only, so there is no WhatsApp Business app inbox to open; no Conversation row exists; and ` +
          `every outbound path sends to a phone number we do not have.`,
        )
        return
      }

      if (!message?.text?.body && !MEDIA_TYPES.has(message?.type)) return

      // Dedup: Meta re-delivers webhooks; skip duplicates (200 already sent above)
      if (isDuplicateMessage(message.id as string)) {
        console.log(`WEBHOOK_DUP → skipped duplicate message.id=${message.id} from=${message.from}`)
        return
      }

      const incomingPhoneId = value?.metadata?.phone_number_id
      const referral        = message.referral ?? null
      const adSource        = detectAdSource(referral)
      const incomingWamid   = message.id as string | undefined
      const contextWamid    = (message as Record<string, any>).context?.id as string | undefined
      // user_id is logged on the NORMAL path too, deliberately. Meta sends both
      // identifiers during the transition, and that overlap is the only window in
      // which an existing phone-keyed conversation can be linked to the same
      // person's BSUID. Knowing whether it has started — and on what share of
      // traffic — is what decides the timing of Phase 1.
      console.log(`Webhook received | phone_number_id: ${incomingPhoneId} | from: ${message.from} | type: ${message.type} | adSource: ${adSource} | user_id: ${describeBsuid(contact?.user_id)}`)

      // Look up company by waPhoneId so multi-tenant routing works correctly
      let company = incomingPhoneId
        ? await this.prisma.company.findFirst({
            where: { waPhoneId: incomingPhoneId, isActive: true },
          })
        : null

      // Unknown waPhoneId — return 200 (Meta requires it) but do NOT process
      if (!company) {
        console.warn(`Unknown waPhoneId ${incomingPhoneId} — message ignored, no company matched`)
        return
      }

      // Resolve which of OUR messages the customer is quoting (if any)
      let resolvedReplyToId: string | undefined
      if (contextWamid) {
        const parentMsg = await this.prisma.message.findFirst({
          where: { conversation: { companyId: company.id }, whatsappMsgId: contextWamid },
          select: { id: true },
        })
        resolvedReplyToId = parentMsg?.id
      }

      // Mark incoming message as read (shows blue ticks to customer)
      if (company.waToken && company.waPhoneId && message.id) {
        await metaPost(company.waPhoneId, company.waToken, {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: message.id,
        })
      }

      // Non-text media: save placeholder + capture + send fixed reply ONLY in AI mode
      if (!message.text?.body) {
        const mediaType = message.type as string
        const media = MEDIA_REPLIES[mediaType] ?? MEDIA_REPLIES['document']
        // Same guarded resolution as the text path: waUserId first, phone only when
        // present. A findFirst on a null phone would match ANY phone-less
        // conversation in this company and hand the customer a stranger's thread.
        const mediaIdentity = { phone: (message.from as string) ?? null, waUserId: bsuid, profileName }
        const conv = await findConversation(this.prisma, company.id, mediaIdentity, {
          orderBy: { updatedAt: 'desc' },
        })
        const isHumanMode = conv?.agentMode === 'HUMAN'
        // Kill-switch check for media path — the main text path gates via handleMessage(),
        // but the media branch is a separate short-circuit that must check both locks itself.
        const mediaAiActive = await isAIConfigActive(this.prisma, company.id)
        console.log(`MEDIA MESSAGE (${mediaType}) from ${message.from} — agentMode=${conv?.agentMode ?? 'new'} humanMode=${isHumanMode} aiActive=${mediaAiActive}`)

        let convId = conv?.id
        if (!convId) {
          // A BSUID-only customer has no phone, and `phone: undefined` would DROP the
          // filter — returning this company's OLDEST lead and attaching a brand-new
          // customer to a stranger's record. No key means no match, so a fresh lead
          // is created, which is the same decision findLead() makes in identity.ts.
          const leadPhone = optionalLookupKey(message.from as string | undefined)
          const existingLead = leadPhone
            ? await this.prisma.lead.findFirst({
                where: { companyId: company.id, phone: leadPhone },
                orderBy: { createdAt: 'asc' },
              })
            : null
          const lead = existingLead ?? await this.prisma.lead.create({
            data: {
              companyId: company.id, phone: (message.from as string) ?? null, source: adSource,
              ...(referral && { referralData: referral }),
            },
          })
          const newConv = await this.prisma.conversation.create({
            data: { companyId: company.id, phone: (message.from as string) ?? null,
                    ...(bsuid && { waUserId: bsuid }),
                    ...(profileName && { profileName }),
                    leadId: lead.id, status: ConvStatus.AI_HANDLING, agentMode: 'HUMAN' },
          })
          convId = newConv.id
          void linkBsuid(this.prisma, convId, bsuid, { phone: message.from })
        }

        // Touch updatedAt so the inbox list re-sorts on every incoming message
        await this.prisma.conversation.update({
          where: { id: convId },
          data: { updatedAt: new Date() },
        })

        // Site 5 — media path. This one already set whatsappMsgId at insert, so with
        // the unique index it is ALSO a dedup claim: a redelivered image now raises
        // P2002 here. Handled explicitly rather than falling into the outer catch,
        // where it would read as a generic "Webhook error".
        let savedUserMsg
        try {
          savedUserMsg = await this.prisma.message.create({
            data: {
              conversationId: convId,
              role: 'USER',
              content: media.label,
              ...(incomingWamid && { whatsappMsgId: incomingWamid }),
              ...(resolvedReplyToId && { replyToId: resolvedReplyToId }),
            },
          })
        } catch (e: any) {
          if (e?.code === 'P2002') {
            console.log(`WEBHOOK_DUP → redelivery of media wamid=${incomingWamid}, not processed`)
            return
          }
          throw e
        }

        // Fire-and-forget: download from Meta → upload to Supabase → stamp mediaUrl on the row.
        // Runs in all modes so the dashboard always shows the actual file.
        if (company.waToken) {
          const rawMediaId = (message as Record<string, any>)[mediaType]?.id as string | undefined
          if (rawMediaId) {
            void captureMedia(
              this.prisma, savedUserMsg.id, rawMediaId, company.waToken,
              company.id, convId, mediaType,
            ).catch(err => console.error(`[MEDIA_CAPTURE] ${mediaType} msg=${savedUserMsg.id}:`, err))
          } else {
            console.warn(`[MEDIA_CAPTURE] no rawMediaId in message for ${mediaType} from ${message.from} — capture skipped`)
          }
        }

        // HUMAN mode OR kill switch OFF: message saved and captured — no auto-reply to customer.
        // Either lock alone is sufficient to block; both must be clear for a canned reply to send.
        if (isHumanMode || !mediaAiActive) {
          const pauseReason = isHumanMode ? 'HUMAN_MODE' : 'KILL_SWITCH'
          console.log(`MEDIA ${pauseReason} (${mediaType}) — saved for ${message.from}, no auto-reply sent`)
          return
        }

        // AI mode with both locks clear.
        // Audio and image: route to human — AI cannot process these safely.
        // Other types (sticker, video, document): send canned "please type" reply.
        if (['audio', 'image'].includes(mediaType)) {
          const aiTemplates = await getAIConfigTemplates(this.prisma, company.id)
          const handoffMsg = buildHandoffMessage(aiTemplates)
          if (company.waToken && company.waPhoneId) {
            await sendWhatsAppMessage(company.waPhoneId, company.waToken, mediaIdentity, handoffMsg)
          }
          await this.prisma.message.create({ data: { conversationId: convId, role: 'ASSISTANT', content: handoffMsg } })
          await this.prisma.conversation.update({
            where: { id: convId },
            data: { status: ConvStatus.NEEDS_HUMAN, handoffMessageSent: true },
          })
          logHandoff(this.prisma, { companyId: company.id, conversationId: convId, phone: message.from, customerMessage: media.label, reason: 'no_handler', category: `media:${mediaType}` })
          console.log(`MEDIA_HANDOFF (${mediaType}) → ${message.from}`)
        } else {
          if (company.waToken && company.waPhoneId) {
            await sendWhatsAppMessage(company.waPhoneId, company.waToken, mediaIdentity, media.reply)
          }
          await this.prisma.message.create({ data: { conversationId: convId, role: 'ASSISTANT', content: media.reply } })
          console.log(`MEDIA REPLY (${mediaType}) sent to ${message.from}`)
        }
        return
      }

      // wamid + replyToId are passed in so the USER-row insert IS the dedup claim
      // (unique index on Message.whatsappMsgId). A Meta redelivery loses that race
      // atomically and returns without calling the model or sending anything.
      // Collects the row ids handleMessage persists, so each row can be stamped with
      // the wamid of the exact Meta message it is.
      const sink: PersistedRowSink = { idGroups: [] }
      const result = await this.whatsapp.handleMessage(
        company.id,
        { phone: (message.from as string) ?? null, waUserId: bsuid, profileName },
        message.text.body, adSource, referral,
        false, incomingWamid, resolvedReplyToId, sink,
      )
      const { replies: replyList, images: replyImages } = normalizeResult(result)

      // Send each reply via Meta WhatsApp Cloud API — split into parts with typing delays
      const hasContent = replyList.some(r => r)
      const target = { phone: (message.from as string) ?? null, waUserId: bsuid }
      if (hasContent && company.waToken && company.waPhoneId) {
        // ── Image FIRST, then the text ──────────────────────────────────────────
        // Order matters: the picture arrives with the programme name as its caption
        // and the full, live-generated detail lands underneath it. The reverse reads
        // as an afterthought, and on a phone the image would push the text out of
        // view just as the customer starts reading the prices.
        //
        // Every failure below is non-fatal by construction. A missing cache entry, a
        // storage fetch that 404s, a media upload Meta rejects — each one leaves
        // `mediaId` null and the loop simply moves on to the text, which is the part
        // that is always correct.
        for (const img of replyImages) {
          let mediaId = await findCachedMediaId(this.prisma, company.id, img.checksum, company.waPhoneId)
          if (mediaId) {
            console.log(`[MEDIA_CACHE_HIT] company=${company.id} checksum=${img.checksum.slice(0, 12)}`)
          } else {
            const up = await uploadImageToMeta(company.waPhoneId, company.waToken, img.url, img.mime)
            mediaId = up?.mediaId ?? null
            if (up) await cacheMediaId(this.prisma, company.id, img.checksum, company.waPhoneId, up.mediaId, img.mime, up.bytes)
          }
          if (!mediaId) continue
          const imgWamid = await sendWhatsAppImage(company.waPhoneId, company.waToken, target, mediaId, img.caption)
          if (imgWamid) await this.recordSentImage(sink.conversationId, img, imgWamid, sink.idGroups[0]?.[0])
        }
        // Reply i was persisted as sink.idGroups[i] (one row per part) and sends as
        // the same parts in the same order, so row j of group i IS Meta message j of
        // send i. Stamp them directly.
        //
        // FAIL-CLOSED on any disagreement: if the counts do not line up, something
        // persisted or sent differently than assumed, and a guessed pairing is how a
        // read receipt ends up on the wrong message. No stamp means no tick, which is
        // an honest silence; a wrong stamp is a confident false statement.
        for (let ri = 0; ri < replyList.length; ri++) {
          const r = replyList[ri]
          if (!r) continue
          const wamids = await sendWhatsAppMessage(company.waPhoneId, company.waToken, target, r)

          await stampParts(this.prisma, sink.idGroups[ri], wamids, `reply ${ri + 1}/${replyList.length}`)
        }
      } else if (hasContent) {
        console.warn(`Reply generated but not sent — waToken or waPhoneId missing for company: ${company.name}`)
      }

      // The second pass that used to live here is GONE. It re-queried "ASSISTANT rows
      // with no wamid in the last 5 minutes" and zipped them positionally against one
      // wamid per reply. Two things were wrong with that and both are now structural
      // rather than guarded: a stale unstamped row from an earlier turn sat at index 0
      // and stole the newest wamid, and a multi-part reply created N rows against a
      // single captured wamid so every later part was unstampable. Stamping now
      // happens inline above, by row id, against the wamid of that exact part.
    } catch (err) {
      console.error('Webhook error:', err)
    }
  }

  /**
   * Record an image the agent actually sent, so the thread shows what the customer got.
   *
   * Until now an agent-sent image left NO trace anywhere. The customer received a
   * picture with a price on it; the conversation history showed only the text that
   * followed. A rep reading the thread could not see what had been sent, could not
   * tell whether the customer was reacting to an image, and had no way to know which
   * programme's picture was in front of them. That is a hole in the record itself,
   * independent of any delivery tick.
   *
   * Stamped at insert with the wamid Meta returned — the same discipline the text
   * path follows — so this row can carry a delivery status without any second pass.
   *
   * TIMESTAMP: images are sent BEFORE the text, but the text rows were persisted
   * earlier, inside handleMessage, before anything was sent. Written with `new Date()`
   * this row would sort BELOW the text it appeared above on the customer's phone. So
   * it is backdated just before the first text row, and the thread reads in the order
   * the customer actually experienced it.
   *
   * Never throws: a failure to record must not take down a reply that already went out.
   */
  private async recordSentImage(
    conversationId: string | undefined,
    img: { url: string; mime: string; caption: string },
    wamid: string,
    firstTextRowId: string | undefined,
  ): Promise<void> {
    if (!conversationId) {
      console.error(`[IMAGE_ROW_SKIPPED] no conversation id on the sink — image ${wamid} not recorded`)
      return
    }
    try {
      // Anchored to the FIRST part of this reply, not the latest row in the thread:
      // a multi-part reply persists several rows, and backdating off the last one
      // would still sort the image below the earlier parts.
      const firstText = firstTextRowId
        ? await this.prisma.message.findUnique({ where: { id: firstTextRowId }, select: { createdAt: true } })
        : null
      const createdAt = firstText ? new Date(firstText.createdAt.getTime() - 1000) : new Date()
      await this.prisma.message.create({
        data: {
          conversationId,
          role: 'ASSISTANT',
          content: img.caption,
          mediaUrl: img.url,
          mediaType: 'image',
          whatsappMsgId: wamid,
          createdAt,
        },
      })
      console.log(`[IMAGE_ROW] conv=${conversationId} wamid=${wamid} recorded`)
    } catch (err) {
      console.error(`[IMAGE_ROW_FAILED] conv=${conversationId} wamid=${wamid} — ${(err as Error)?.message}`)
    }
  }

  @Post('test')
  async test(
    // wamid: optional, test-only. Lets the dedup regression suite exercise the
    // claim without driving the real Meta webhook, which would trigger an actual
    // WhatsApp send. Never supplied by production traffic.
    @Body() body: { phone?: string; message: string; simulate?: boolean; wamid?: string; waUserId?: string },
    @Headers('x-internal-token') token: string,
  ) {
    assertInternalToken(token, 'TEST_ENDPOINT_TOKEN')
    try {
      console.log('--- /webhook/test called ---')
      console.log('DEFAULT_COMPANY_ID:', process.env.DEFAULT_COMPANY_ID ?? '❌ NOT SET')

      const companyId = process.env.DEFAULT_COMPANY_ID
      if (!companyId) {
        return { error: 'DEFAULT_COMPANY_ID not set' }
      }

      // simulate=true: bypasses AI-pause gates so catalog bypasses can be tested while AI stays locked.
      // This endpoint NEVER calls sendWhatsAppMessage — replies are returned via HTTP only.
      // The simulate flag is ONLY accepted here; it is never passed by the real Meta webhook path.
      const simulate = body.simulate === true
      if (simulate) {
        console.log('[SIMULATE] mode active — gates bypassed, replies returned via HTTP only, not persisted to DB')
      }

      console.log(`🔍 Looking up company: ${companyId}`)
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
      })
      console.log('Company found:', company ? `✅ ${company.name}` : '❌ NOT IN DATABASE')

      if (!company) {
        return { error: `Company ${companyId} not found in database` }
      }

      const result = await this.whatsapp.handleMessage(
        companyId,
        // A test caller may supply either half, or both — mirroring what Meta sends.
        { phone: body.waUserId ? (body.phone ?? null) : (body.phone ?? '201234567890'),
          waUserId: body.waUserId ?? null },
        body.message ?? 'مرحباً',
        'direct',
        null,
        simulate,  // structural guarantee: ONLY this endpoint passes simulate=true
        body.wamid,
      )

      // Stamp the conversation as a test so it is excluded from the sales inbox.
      // Done after handleMessage so the conversation is guaranteed to exist.
      await this.prisma.conversation.updateMany({
        where: { companyId, phone: body.phone ?? '201234567890' },
        data: { isTest: true },
      })

      const { replies, images } = normalizeResult(result)
      const parts = replies.flatMap(r => r ? splitIntoMessages(r) : [])
      console.log(`TEST${simulate ? ' [SIMULATE]' : ''}: ${replies.length} message(s), ${parts.length} part(s) total`)
      replies.forEach((r, i) => {
        const rParts = r ? splitIntoMessages(r) : []
        rParts.forEach((p, pi) => console.log(`  [msg${i + 1} part${pi + 1}] ${p.substring(0, 80)}`))
      })
      // Descriptors are RETURNED, never uploaded or sent. This endpoint is what every
      // gate suite drives, so the decision "would an image go with this reply, and
      // which one" becomes assertable without a single byte reaching Meta.
      images.forEach(img => console.log(`  [image] ${img.checksum.slice(0, 12)} caption="${img.caption}"`))
      return { simulate, replies, parts, images }
    } catch (err: any) {
      console.error('❌ /webhook/test error:', err?.message ?? err)
      return { error: err?.message ?? 'Internal server error', stack: err?.stack?.split('\n').slice(0, 3) }
    }
  }

  // Test media handling — simulates receiving a non-text message
  @Post('test-media')
  async testMedia(
    @Body() body: { phone: string; type: string },
    @Headers('x-internal-token') token: string,
  ) {
    assertInternalToken(token, 'TEST_ENDPOINT_TOKEN')
    const companyId = process.env.DEFAULT_COMPANY_ID
    if (!companyId) return { error: 'DEFAULT_COMPANY_ID not set' }
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })
    if (!company) return { error: 'Company not found' }
    const phone = body.phone ?? '201234567890'
    const mediaType = body.type ?? 'image'
    const media = MEDIA_REPLIES[mediaType] ?? MEDIA_REPLIES['document']
    const conv = await this.prisma.conversation.findFirst({
      where: { companyId, phone, status: { not: ConvStatus.CLOSED } },
      orderBy: { updatedAt: 'desc' },
    })
    let convId = conv?.id
    if (!convId) {
      const lead = await this.prisma.lead.create({ data: { companyId, phone, source: 'whatsapp' } })
      const newConv = await this.prisma.conversation.create({
        data: { companyId, phone, leadId: lead.id, status: ConvStatus.AI_HANDLING, agentMode: 'HUMAN', isTest: true },
      })
      convId = newConv.id
    } else {
      await this.prisma.conversation.update({ where: { id: convId }, data: { isTest: true } })
    }
    await this.prisma.message.create({ data: { conversationId: convId, role: 'USER', content: media.label } })
    await this.prisma.message.create({ data: { conversationId: convId, role: 'ASSISTANT', content: media.reply } })
    return { type: mediaType, label: media.label, reply: media.reply }
  }

  // Dashboard "take over with AI reply" — generates one AI reply for an existing
  // conversation without duplicating the user message. Called by the dashboard before
  // switching agentMode to HUMAN, so the customer gets a reply before the rep takes over.
  @Post('convreply')
  async convReply(
    @Body() body: { convId: string; companyId: string },
    @Headers('x-internal-token') token: string,
  ) {
    assertInternalToken(token, 'TEST_ENDPOINT_TOKEN')
    try {
      if (!body.convId)    return { error: 'convId required' }
      if (!body.companyId) return { error: 'companyId required' }
      const { reply, messageIds, phone, waUserId, waToken, waPhoneId, error } = await this.whatsapp.triggerAIReply(body.convId, body.companyId)
      if (!reply) return { success: false, error: error ?? 'no reply generated' }

      // Addressed by phone when we have one, by BSUID when we do not.
      if (waToken && waPhoneId) {
        const wamids = await sendWhatsAppMessage(waPhoneId, waToken, { phone, waUserId }, reply)
        // `.some(Boolean)`, not `!wamids`: this now returns an ARRAY, and an array —
        // even an empty one — is truthy, so a bare falsiness check would silently
        // never fire and a total send failure would report success.
        if (!wamids.some(Boolean)) return { success: false, error: 'تعذّر إرسال الرسالة — راجع السجلات' }
        await stampParts(this.prisma, messageIds, wamids, 'convReply')
      }

      return { success: true, reply }
    } catch (err: any) {
      console.error('convReply error:', err)
      return { error: err?.message ?? 'Internal error' }
    }
  }

  // Manually trigger the follow-up cron (bypasses time window — for testing only)
  @Post('test-followup')
  async testFollowup(@Headers('x-internal-token') token: string) {
    assertInternalToken(token, 'TEST_ENDPOINT_TOKEN')
    return this.followup.triggerNow()
  }

  // Internal: dashboard calls this after Offering writes to bust the in-memory catalog cache.
  // Protected by INTERNAL_CACHE_TOKEN header — only reachable from trusted callers.
  @Post('internal/cache-bust')
  cacheBust(
    @Body() body: { companyId: string },
    @Headers('x-internal-token') token: string,
  ) {
    assertInternalToken(token, 'INTERNAL_CACHE_TOKEN')
    if (!body.companyId) return { error: 'companyId required' }
    invalidateCatalogCache(body.companyId)
    return { ok: true }
  }
}
