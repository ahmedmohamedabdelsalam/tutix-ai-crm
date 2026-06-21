import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(private prisma: PrismaService) {}

  // Runs every day at 9:00 AM
  @Cron('0 9 * * *')
  async checkSubscriptions() {
    this.logger.log('🔔 Running daily subscription check...');

    const now = new Date();
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // 1 — Find companies expiring within 7 days (still active)
    const expiringSoon = await this.prisma.company.findMany({
      where: {
        isActive: true,
        subscriptionEnd: {
          gte: now,
          lte: in7Days,
        },
      },
      select: { id: true, name: true, subscriptionEnd: true, ownerName: true },
    });

    for (const company of expiringSoon) {
      const daysLeft = Math.ceil(
        (company.subscriptionEnd!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      this.logger.warn(
        `⚠️  EXPIRING SOON: ${company.name} — ${daysLeft} day(s) left (ends ${company.subscriptionEnd!.toISOString().slice(0, 10)})`,
      );
      // TODO: send email notification to TUTIX admin + company owner
    }

    // 2 — Auto-deactivate companies whose subscription has expired
    const expired = await this.prisma.company.updateMany({
      where: {
        isActive: true,
        subscriptionEnd: { lt: now },
      },
      data: { isActive: false },
    });

    if (expired.count > 0) {
      this.logger.warn(`🚫 Auto-deactivated ${expired.count} expired company(ies)`);
    }

    // 3 — API spend monitoring
    await this.checkApiSpend();

    this.logger.log(
      `✅ Subscription check done — ${expiringSoon.length} expiring soon, ${expired.count} deactivated`,
    );
  }

  private async checkApiSpend(): Promise<void> {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const warnUSD = parseFloat(process.env.API_DAILY_SPEND_WARN_USD ?? '1.50');
    const creditBalance = parseFloat(process.env.ANTHROPIC_CREDIT_BALANCE_USD ?? '0');

    // Sum last 24h api_cost records per company
    const recentCosts = await this.prisma.agentInsight.findMany({
      where: { type: 'api_cost', createdAt: { gte: oneDayAgo } },
      select: { companyId: true, content: true },
    });
    const perCompany = new Map<string, number>();
    for (const r of recentCosts) {
      const cost = parseFloat(r.content ?? '0') || 0;
      perCompany.set(r.companyId, (perCompany.get(r.companyId) ?? 0) + cost);
    }

    for (const [companyId, dailyCost] of perCompany) {
      if (dailyCost >= warnUSD) {
        this.logger.warn(`💸 HIGH_API_SPEND: company=${companyId} daily=$${dailyCost.toFixed(4)} threshold=$${warnUSD}`);
        await this.prisma.systemNotification.create({
          data: {
            companyId,
            type: 'API_HIGH_SPEND',
            message: `تنبيه: استهلاك Anthropic API مرتفع — $${dailyCost.toFixed(4)} في آخر 24 ساعة (الحد التحذيري $${warnUSD})`,
          },
        });
      }
    }

    // Estimate days-remaining if ANTHROPIC_CREDIT_BALANCE_USD is configured
    if (creditBalance > 0) {
      const weekCosts = await this.prisma.agentInsight.findMany({
        where: { type: 'api_cost', createdAt: { gte: sevenDaysAgo } },
        select: { content: true },
      });
      const totalWeek = weekCosts.reduce((s, r) => s + (parseFloat(r.content ?? '0') || 0), 0);
      const avgDailySpend = totalWeek / 7;

      if (avgDailySpend > 0) {
        const daysRemaining = creditBalance / avgDailySpend;
        this.logger.log(`📊 API burn rate: $${avgDailySpend.toFixed(4)}/day → ~${daysRemaining.toFixed(1)} days remaining`);
        if (daysRemaining < 5) {
          this.logger.error(`🔴 API_CREDITS_LOW: est. ${daysRemaining.toFixed(1)} days remaining`);
          const activeCompanies = await this.prisma.company.findMany({
            where: { isActive: true },
            select: { id: true },
          });
          for (const company of activeCompanies) {
            await this.prisma.systemNotification.create({
              data: {
                companyId: company.id,
                type: 'API_CREDITS_LOW',
                message: `تنبيه عاجل: رصيد Anthropic API قد ينفذ خلال ${daysRemaining.toFixed(1)} يوم — يرجى إعادة الشحن`,
              },
            });
          }
        }
      }
    }
  }

  // Manual trigger for testing (also usable from admin endpoints)
  async runCheckNow() {
    await this.checkSubscriptions();
    return { ran: true, ts: new Date().toISOString() };
  }
}
