import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../prisma/prisma.service'
import { FollowUpStatus, ConvStatus, MessageRole } from '@prisma/client'
import { clampToWindow } from './whatsapp.service'

function categorizeDropOff(lastMsg: string, totalMsgCount: number): string {
  if (/غالي|تخفيض|خصم|أرخص/.test(lastMsg)) return 'بعد التعامل مع اعتراض'
  if (/جنيه|السعر|الإجمالي/.test(lastMsg))  return 'بعد عرض الأسعار'
  if (/يوليو|أغسطس|كام يوم|مدة الرحلة/.test(lastMsg)) return 'بعد سؤال الشهر/المدة'
  if (/كام شخص|عدد الأفراد|معاك كام/.test(lastMsg)) return 'بعد سؤال عدد الأفراد'
  if (/تشرفنا باسم|نورتنا|إزاي أقدر أساعدك|إيه اللي تحب|تحب أعرفك/.test(lastMsg) && totalMsgCount <= 4) return 'بعد التحية / السؤال عن الاسم'
  return 'أخرى'
}

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

    await this.analyzeDropOffs(bypassWindow)
    return { sent, skipped: null }
  }

  private async analyzeDropOffs(bypassHours = false): Promise<void> {
    const cutoff = bypassHours
      ? new Date(Date.now() + 60_000)           // effectively "all AI_HANDLING convs"
      : new Date(Date.now() - 2 * 60 * 60_000)  // idle for >2h

    const stale = await this.prisma.conversation.findMany({
      where: {
        dropOffAnalyzed: false,
        status: ConvStatus.AI_HANDLING,
        updatedAt: { lt: cutoff },
      },
      select: {
        id: true,
        companyId: true,
        phone: true,
        _count: { select: { messages: true } },
        messages: {
          where: { role: MessageRole.ASSISTANT },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { content: true },
        },
      },
    })

    this.logger.log(`Drop-off analysis: ${stale.length} conversation(s) to classify`)
    for (const conv of stale) {
      const lastAsst = conv.messages[0]
      const category = lastAsst
        ? categorizeDropOff(lastAsst.content, conv._count.messages)
        : 'أخرى'

      await Promise.all([
        this.prisma.agentInsight.create({
          data: { companyId: conv.companyId, conversationId: conv.id, type: 'drop_off_stage', category },
        }),
        this.prisma.conversation.update({
          where: { id: conv.id },
          data: { dropOffAnalyzed: true },
        }),
      ])
      this.logger.log(`DROP-OFF: ${conv.phone} → ${category}`)
    }
  }

  // Manual trigger for testing — bypasses time window AND 2h idle threshold
  async triggerNow(): Promise<{ ran: boolean; ts: string; result: { sent: number; skipped: string | null } }> {
    const result = await this.sendDueFollowUps(true)
    return { ran: true, ts: new Date().toISOString(), result }
  }
}
