import { Controller, Get, Post, Body, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { ConvStatus } from '@prisma/client'
import { WhatsAppService } from './whatsapp.service'
import { FollowUpService } from './followup.service'
import { PrismaService } from '../prisma/prisma.service'
import { splitIntoMessages } from './message-splitter'

function getTypingDelay(_text: string): number {
  return 5000
}

async function metaPost(phoneId: string, token: string, body: object): Promise<void> {
  await fetch(`https://graph.facebook.com/v18.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const MEDIA_REPLIES: Record<string, { label: string; reply: string }> = {
  audio:    { label: '[رسالة صوتية]',   reply: 'حضرتك بعتلنا رسالة صوتية، للأسف مش بنقدر نسمعها دلوقتي لو ممكن تكتب طلبك يافندم نكون شاكرين' },
  sticker:  { label: '[استيكر]',        reply: 'ممكن تكتب طلبك أو سؤالك يافندم' },
  image:    { label: '[صورة]',           reply: 'ممكن تكتب لنا التفاصيل اللي حابب تستفسر عنها يافندم وفريقنا هيتابع مع حضرتك في حالة وجود أي إجراء مطلوب' },
  video:    { label: '[فيديو]',          reply: 'ممكن تكتب طلبك أو سؤالك يافندم' },
  document: { label: '[ملف]',           reply: 'ممكن تكتب طلبك أو سؤالك يافندم' },
}
const MEDIA_TYPES = new Set(Object.keys(MEDIA_REPLIES))

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

      const incomingPhoneId = value?.metadata?.phone_number_id
      const referral        = message.referral ?? null
      const adSource        = detectAdSource(referral)
      console.log(`Webhook received | phone_number_id: ${incomingPhoneId} | from: ${message.from} | type: ${message.type} | adSource: ${adSource}`)

      // Look up company by waPhoneId so multi-tenant routing works correctly
      let company = incomingPhoneId
        ? await this.prisma.company.findFirst({
            where: { waPhoneId: incomingPhoneId, isActive: true },
          })
        : null

      // Fallback to DEFAULT_COMPANY_ID for legacy / test use
      if (!company) {
        const fallbackId = process.env.DEFAULT_COMPANY_ID
        if (!fallbackId) {
          console.warn(`No company found for phone_number_id: ${incomingPhoneId} and no DEFAULT_COMPANY_ID set`)
          return
        }
        company = await this.prisma.company.findUnique({ where: { id: fallbackId } })
        if (!company || !company.isActive) {
          console.warn(`Fallback company ${fallbackId} not found or inactive`)
          return
        }
        console.warn(`Using DEFAULT_COMPANY_ID fallback for phone_number_id: ${incomingPhoneId}`)
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
        await this.prisma.message.create({
          data: { conversationId: convId, role: 'USER', content: media.label },
        })
        if (company.waToken && company.waPhoneId) {
          await new Promise(r => setTimeout(r, 1500))
          await metaPost(company.waPhoneId, company.waToken, {
            messaging_product: 'whatsapp',
            to: message.from,
            type: 'text',
            text: { body: media.reply },
          })
        }
        await this.prisma.message.create({
          data: { conversationId: convId, role: 'ASSISTANT', content: media.reply },
        })
        console.log(`MEDIA REPLY (${mediaType}) sent to ${message.from}`)
        return
      }

      const reply = await this.whatsapp.handleMessage(company.id, message.from, message.text.body, adSource, referral)

      // Send reply back via Meta WhatsApp Cloud API — split into multiple messages with typing delays
      if (reply && company.waToken && company.waPhoneId) {
        const parts = splitIntoMessages(reply)
        console.log(`Sending ${parts.length} part(s) to ${message.from}`)
        for (let pi = 0; pi < parts.length; pi++) {
          const part = parts[pi]
          const delay = getTypingDelay(part)
          console.log(`Part ${pi + 1}/${parts.length} (${part.length} chars, delay ${Math.round(delay / 1000)}s): ${part.substring(0, 60)}`)
          await new Promise(r => setTimeout(r, delay))
          const metaRes = await fetch(
            `https://graph.facebook.com/v18.0/${company.waPhoneId}/messages`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${company.waToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: message.from,
                type: 'text',
                text: { body: part },
              }),
            },
          )
          if (!metaRes.ok) {
            const err = await metaRes.text()
            console.error(`Meta API error on part ${pi + 1} (${metaRes.status}):`, err)
          }
        }
        console.log(`All ${parts.length} part(s) sent to ${message.from} via ${company.waPhoneId}`)
      } else if (reply) {
        console.warn(`Reply generated but not sent — waToken or waPhoneId missing for company: ${company.name}`)
      }
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

      const reply = await this.whatsapp.handleMessage(
        companyId,
        body.phone ?? '201234567890',
        body.message ?? 'مرحباً',
      )
      const parts = reply ? splitIntoMessages(reply) : []
      console.log(`TEST split: ${parts.length} part(s)`)
      parts.forEach((p, i) => console.log(`  [${i + 1}] ${p.substring(0, 80)}`))
      return { reply, parts }
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
  async convReply(@Body() body: { convId: string }) {
    try {
      if (!body.convId) return { error: 'convId required' }
      const { reply, phone, waToken, waPhoneId } = await this.whatsapp.triggerAIReply(body.convId)
      if (!reply) return { success: false, error: 'no reply generated' }

      if (waToken && waPhoneId) {
        const parts = splitIntoMessages(reply)
        for (let pi = 0; pi < parts.length; pi++) {
          const delay = getTypingDelay(parts[pi])
          await new Promise(r => setTimeout(r, delay))
          await metaPost(waPhoneId, waToken, {
            messaging_product: 'whatsapp',
            to: phone,
            type: 'text',
            text: { body: parts[pi] },
          })
        }
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
