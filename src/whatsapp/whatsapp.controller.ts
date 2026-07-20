import { Controller, Get, Post, Body, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { ConvStatus } from '@prisma/client'
import { WhatsAppService } from './whatsapp.service'
import { FollowUpService } from './followup.service'
import { PrismaService } from '../prisma/prisma.service'
import { splitIntoMessages } from './message-splitter'
import { metaPost, sendWhatsAppMessage } from './send-message'
import { captureMedia } from './capture-media'

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
  async receive(@Body() body: any, @Res() res: Response) {
    // Must return 200 to Meta immediately before any async work
    res.status(200).send('OK')
    try {
      const value   = body?.entry?.[0]?.changes?.[0]?.value
      const message = value?.messages?.[0]
      if (!message?.from || !message?.id) return
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
      console.log(`Webhook received | phone_number_id: ${incomingPhoneId} | from: ${message.from} | type: ${message.type} | adSource: ${adSource}`)

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

      // Non-text media: save placeholder + send fixed reply, skip AI entirely
      if (!message.text?.body) {
        const mediaType = message.type as string
        const media = MEDIA_REPLIES[mediaType] ?? MEDIA_REPLIES['document']
        console.log(`MEDIA MESSAGE (${mediaType}) from ${message.from} — sending fixed reply`)
        const conv = await this.prisma.conversation.findFirst({
          where: { companyId: company.id, phone: message.from, status: { not: ConvStatus.CLOSED } },
          orderBy: { updatedAt: 'desc' },
        })
        let convId = conv?.id
        if (!convId) {
          const existingLead = await this.prisma.lead.findFirst({
            where: { companyId: company.id, phone: message.from },
            orderBy: { createdAt: 'asc' },
          })
          const lead = existingLead ?? await this.prisma.lead.create({
            data: {
              companyId: company.id, phone: message.from, source: adSource,
              ...(referral && { referralData: referral }),
            },
          })
          const newConv = await this.prisma.conversation.create({
            data: { companyId: company.id, phone: message.from, leadId: lead.id, status: ConvStatus.AI_HANDLING },
          })
          convId = newConv.id
        }
        const savedUserMsg = await this.prisma.message.create({
          data: {
            conversationId: convId,
            role: 'USER',
            content: media.label,
            ...(incomingWamid && { whatsappMsgId: incomingWamid }),
            ...(resolvedReplyToId && { replyToId: resolvedReplyToId }),
          },
        })

        // Fire-and-forget: download from Meta → upload to Supabase → stamp mediaUrl on the row.
        // Never blocks the 200 response. Failures are logged; the placeholder stays as fallback.
        if (company.waToken) {
          const rawMediaId = (message as Record<string, any>)[mediaType]?.id as string | undefined
          if (rawMediaId) {
            void captureMedia(
              this.prisma, savedUserMsg.id, rawMediaId, company.waToken,
              company.id, convId, mediaType,
            ).catch(err => console.error(`[MEDIA_CAPTURE] ${mediaType} msg=${savedUserMsg.id}:`, err))
          }
        }

        if (company.waToken && company.waPhoneId) {
          await sendWhatsAppMessage(company.waPhoneId, company.waToken, message.from, media.reply)
        }
        await this.prisma.message.create({
          data: { conversationId: convId, role: 'ASSISTANT', content: media.reply },
        })
        console.log(`MEDIA REPLY (${mediaType}) sent to ${message.from}`)
        return
      }

      const result = await this.whatsapp.handleMessage(company.id, message.from, message.text.body, adSource, referral)
      const replyList = Array.isArray(result) ? result : (result ? [result] : [])

      // Send each reply via Meta WhatsApp Cloud API — split into parts with typing delays
      const hasContent = replyList.some(r => r)
      const outWamids: (string | null)[] = []
      if (hasContent && company.waToken && company.waPhoneId) {
        for (const r of replyList) {
          if (!r) continue
          const w = await sendWhatsAppMessage(company.waPhoneId, company.waToken, message.from, r)
          outWamids.push(w)
        }
      } else if (hasContent) {
        console.warn(`Reply generated but not sent — waToken or waPhoneId missing for company: ${company.name}`)
      }

      // Fire-and-forget: stamp wamid on incoming USER message + outgoing ASSISTANT messages
      void (async () => {
        const cutoff = new Date(Date.now() - 300000) // 5-min window
        const phone  = message.from as string
        if (incomingWamid) {
          const lastUser = await this.prisma.message.findFirst({
            where: { conversation: { companyId: company.id, phone }, role: 'USER', whatsappMsgId: null, createdAt: { gte: cutoff } },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
          })
          if (lastUser) {
            await this.prisma.message.update({
              where: { id: lastUser.id },
              data: { whatsappMsgId: incomingWamid, ...(resolvedReplyToId && { replyToId: resolvedReplyToId }) },
            })
          }
        }
        if (outWamids.some(w => w)) {
          const recentAsst = await this.prisma.message.findMany({
            where: { conversation: { companyId: company.id, phone }, role: 'ASSISTANT', whatsappMsgId: null, createdAt: { gte: cutoff } },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          })
          for (let i = 0; i < Math.min(recentAsst.length, outWamids.length); i++) {
            if (outWamids[i]) {
              await this.prisma.message.update({
                where: { id: recentAsst[i].id },
                data: { whatsappMsgId: outWamids[i] },
              })
            }
          }
        }
      })().catch(err => console.error('[WAMID_STAMP]', err))
    } catch (err) {
      console.error('Webhook error:', err)
    }
  }

  @Post('test')
  async test(@Body() body: { phone: string; message: string }) {
    try {
      console.log('--- /webhook/test called ---')
      console.log('DEFAULT_COMPANY_ID:', process.env.DEFAULT_COMPANY_ID ?? '❌ NOT SET')

      const companyId = process.env.DEFAULT_COMPANY_ID
      if (!companyId) {
        return { error: 'DEFAULT_COMPANY_ID not set' }
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
        body.phone ?? '201234567890',
        body.message ?? 'مرحباً',
      )
      const replies = Array.isArray(result) ? result : (result ? [result] : [])
      const parts = replies.flatMap(r => r ? splitIntoMessages(r) : [])
      console.log(`TEST: ${replies.length} message(s), ${parts.length} part(s) total`)
      replies.forEach((r, i) => {
        const rParts = r ? splitIntoMessages(r) : []
        rParts.forEach((p, pi) => console.log(`  [msg${i + 1} part${pi + 1}] ${p.substring(0, 80)}`))
      })
      return { replies, parts }
    } catch (err: any) {
      console.error('❌ /webhook/test error:', err?.message ?? err)
      return { error: err?.message ?? 'Internal server error', stack: err?.stack?.split('\n').slice(0, 3) }
    }
  }

  // Test media handling — simulates receiving a non-text message
  @Post('test-media')
  async testMedia(@Body() body: { phone: string; type: string }) {
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
        data: { companyId, phone, leadId: lead.id, status: ConvStatus.AI_HANDLING },
      })
      convId = newConv.id
    }
    await this.prisma.message.create({ data: { conversationId: convId, role: 'USER', content: media.label } })
    await this.prisma.message.create({ data: { conversationId: convId, role: 'ASSISTANT', content: media.reply } })
    return { type: mediaType, label: media.label, reply: media.reply }
  }

  // Dashboard "take over with AI reply" — generates one AI reply for an existing
  // conversation without duplicating the user message. Called by the dashboard before
  // switching agentMode to HUMAN, so the customer gets a reply before the rep takes over.
  @Post('convreply')
  async convReply(@Body() body: { convId: string; companyId: string }) {
    try {
      if (!body.convId)    return { error: 'convId required' }
      if (!body.companyId) return { error: 'companyId required' }
      const { reply, phone, waToken, waPhoneId } = await this.whatsapp.triggerAIReply(body.convId, body.companyId)
      if (!reply) return { success: false, error: 'no reply generated' }

      if (waToken && waPhoneId) {
        await sendWhatsAppMessage(waPhoneId, waToken, phone, reply)
      }

      return { success: true, reply }
    } catch (err: any) {
      console.error('convReply error:', err)
      return { error: err?.message ?? 'Internal error' }
    }
  }

  // Manually trigger the follow-up cron (bypasses time window — for testing only)
  @Post('test-followup')
  async testFollowup() {
    return this.followup.triggerNow()
  }
}
