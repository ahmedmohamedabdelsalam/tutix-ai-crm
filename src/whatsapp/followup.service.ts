import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../prisma/prisma.service'
import { FollowUpStatus, ConvStatus, MessageRole } from '@prisma/client'
import { clampToWindow } from './follow-up-scheduler'
import { CAIRO_OFFSET_MS } from '../utils/arabic-numerals'
import { sendWhatsAppMessage } from './send-message'

function categorizeDropOff(lastMsg: string, totalMsgCount: number): string {
  if (/غالي|تخفيض|خصم|أرخص/.test(lastMsg)) return 'بعد التعامل مع اعتراض'
  if (/جنيه|السعر|الإجمالي/.test(lastMsg))  return 'بعد عرض الأسعار'
  if (/يوليو|أغسطس|كام يوم|مدة الرحلة/.test(lastMsg)) return 'بعد سؤال الشهر/المدة'
  if (/كام شخص|عدد الأفراد|معاك كام/.test(lastMsg)) return 'بعد سؤال عدد الأفراد'
  if (/تشرفنا باسم|نورتنا|إزاي أقدر أساعدك|إيه اللي تحب|تحب أعرفك/.test(lastMsg) && totalMsgCount <= 4) return 'بعد التحية / السؤال عن الاسم'
  return 'أخرى'
}

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

    // Process each company in isolation: one DB query per company, credentials
    // checked before querying so a tenant without WA config is skipped cleanly
    // and cannot affect another tenant's run.
    const companies = await this.prisma.company.findMany({
      where: { isActive: true },
      select: { id: true, name: true, waToken: true, waPhoneId: true },
    })

    this.logger.log(`Follow-up check: ${companies.length} active company(ies) (Cairo hour=${hour})`)

    let sent = 0
    for (const company of companies) {
      if (!company.waToken || !company.waPhoneId) {
        this.logger.debug(`Follow-up: skipping ${company.name} — no WA credentials`)
        continue
      }

      const due = await this.prisma.conversation.findMany({
        where: {
          companyId: company.id,
          followUpStatus: FollowUpStatus.SCHEDULED,
          followUpScheduledAt: { lte: now },
        },
        include: {
          lead: { select: { name: true } },
        },
      })

      this.logger.log(`Follow-up [${company.name}]: ${due.length} due conversation(s)`)

      for (const conv of due) {
        const leadName = conv.lead?.name?.trim()
        const greeting = leadName ? `يا أستاذ ${leadName}` : 'يافندم'
        const msg = `السلام عليكم ${greeting}\nحضرتك فكرت في موضوع الرحلة يافندم؟\nتحت أمرك لو احتجت أي تفاصيل`

        try {
          await sendWhatsAppMessage(company.waPhoneId, company.waToken, conv.phone, msg)
          this.logger.log(`Follow-up sent → ${conv.phone} (${company.name})`)
        } catch (e) {
          this.logger.error(`Failed to send follow-up to ${conv.phone}:`, e)
        }

        // Mark as sent + save to message history regardless of send result
        try {
          await this.prisma.conversation.update({
            where: { id: conv.id },
            data: { followUpStatus: FollowUpStatus.SENT, followUpScheduledAt: null },
          })
          await this.prisma.message.create({
            data: { conversationId: conv.id, role: 'ASSISTANT', content: msg },
          })
        } catch (err) {
          this.logger.error(`DB_ERROR follow-up mark-sent conv=${conv.id}`, err)
        }
        sent++
      }
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
