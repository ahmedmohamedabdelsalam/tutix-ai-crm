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
    res.status(200).send('OK')
    try {
      const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
      if (!message?.text?.body) return
      const companyId = process.env.DEFAULT_COMPANY_ID
      if (!companyId) return
      await this.whatsapp.handleMessage(companyId, message.from, message.text.body)
    } catch (err) {
      console.error('Webhook error:', err)
    }
  }

  @Post('test')
  async test(@Body() body: { phone: string; message: string }) {
    console.log('--- /webhook/test called ---')
    console.log('DEFAULT_COMPANY_ID:', process.env.DEFAULT_COMPANY_ID ?? '❌ NOT SET')
    console.log(
      'ENV keys present:',
      Object.keys(process.env)
        .filter((k) => !k.startsWith('npm_') && !k.startsWith('NODE'))
        .join(', '),
    )

    const companyId = process.env.DEFAULT_COMPANY_ID
    if (!companyId) {
      console.error('❌ DEFAULT_COMPANY_ID is empty or not set on this environment')
      return { error: 'DEFAULT_COMPANY_ID not set in .env' }
    }

    // DB check — verify the company exists
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
  }
}
