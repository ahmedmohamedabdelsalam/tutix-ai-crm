import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../prisma/prisma.service'
import { FollowUpStatus } from '@prisma/client'
import { clampToWindow } from './whatsapp.service'

const CAIRO_OFFSET_MS = 2 * 60 * 60 * 1000

function getCairoHour(): number {
  return new Date(Date.now() + CAIRO_OFFSET_MS).getUTCHours()
}

@Injectable()
export class FollowUpService {
  private readonly logger = new Logger(FollowUpService.name)

  constructor(private prisma: PrismaService) {}

  @Cron('*/15 * * * *')
  async sendDueFollowUps(bypassWindow = false): Promise<{ sent: number; skipped: string | null }> {
    const hour = getCairoHour()
    if (!bypassWindow && (hour < 9 || hour >= 22)) {
      this.logger.debug(`Follow-up check skipped — outside Cairo window (hour=${hour})`)
      return { sent: 0, skipped: `outside window (Cairo hour=${hour})` }
    }

    const now = new Date()
    const due = await this.prisma.conversation.findMany({
      where: {
        followUpStatus: FollowUpStatus.SCHEDULED,
        followUpScheduledAt: { lte: now },
      },
      include: {
        company: { select: { id: true, waToken: true, waPhoneId: true, name: true } },
        lead: { select: { name: true } },
      },
    })

    this.logger.log(`Follow-up check: ${due.length} due conversation(s) (Cairo hour=${hour})`)

    let sent = 0
    for (const conv of due) {
      const leadName = conv.lead?.name?.trim()
      const greeting = leadName ? `يا أستاذ ${leadName}` : 'يافندم'
      const msg = `السلام عليكم ${greeting}\nحضرتك فكرت في موضوع الرحلة يافندم؟\nتحت أمرك لو احتجت أي تفاصيل`

      // Send via Meta API if credentials available
      if (conv.company.waToken && conv.company.waPhoneId) {
        try {
          const res = await fetch(
            `https://graph.facebook.com/v18.0/${conv.company.waPhoneId}/messages`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${conv.company.waToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: conv.phone,
                type: 'text',
                text: { body: msg },
              }),
            },
          )
          if (!res.ok) {
            const err = await res.text()
            this.logger.error(`Meta API error for ${conv.phone}: ${err}`)
          } else {
            this.logger.log(`Follow-up sent → ${conv.phone} (${conv.company.name})`)
          }
        } catch (e) {
          this.logger.error(`Failed to send follow-up to ${conv.phone}:`, e)
        }
      } else {
        // No credentials (test env) — log message only
        this.logger.warn(`FOLLOW-UP (no waToken) → ${conv.phone}: ${msg.replace(/\n/g, ' | ')}`)
      }

      // Mark as sent + save to message history regardless of send result
      await this.prisma.conversation.update({
        where: { id: conv.id },
        data: { followUpStatus: FollowUpStatus.SENT, followUpScheduledAt: null },
      })
      await this.prisma.message.create({
        data: { conversationId: conv.id, role: 'ASSISTANT', content: msg },
      })
      sent++
    }

    return { sent, skipped: null }
  }

  // Manual trigger for testing — bypasses time window
  async triggerNow(): Promise<{ ran: boolean; ts: string; result: { sent: number; skipped: string | null } }> {
    const result = await this.sendDueFollowUps(true)
    return { ran: true, ts: new Date().toISOString(), result }
  }
}
