import { Controller, Get, Post, Body, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { WhatsAppService } from './whatsapp.service'
import { PrismaService } from '../prisma/prisma.service'

@Controller('webhook')
export class WhatsAppController {
  constructor(
    private whatsapp: WhatsAppService,
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
      if (!message?.text?.body) return

      const incomingPhoneId = value?.metadata?.phone_number_id
      console.log(`Webhook received | phone_number_id: ${incomingPhoneId} | from: ${message.from}`)

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

      const reply = await this.whatsapp.handleMessage(company.id, message.from, message.text.body)

      // Send reply back via Meta WhatsApp Cloud API
      if (reply && company.waToken && company.waPhoneId) {
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
              text: { body: reply },
            }),
          },
        )
        if (!metaRes.ok) {
          const err = await metaRes.text()
          console.error(`Meta API error (${metaRes.status}):`, err)
        } else {
          console.log(`Reply sent to ${message.from} via ${company.waPhoneId}`)
        }
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
      return { reply }
    } catch (err: any) {
      console.error('❌ /webhook/test error:', err?.message ?? err)
      return { error: err?.message ?? 'Internal server error', stack: err?.stack?.split('\n').slice(0, 3) }
    }
  }
}
