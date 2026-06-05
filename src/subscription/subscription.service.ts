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

    this.logger.log(
      `✅ Subscription check done — ${expiringSoon.length} expiring soon, ${expired.count} deactivated`,
    );
  }

  // Manual trigger for testing (also usable from admin endpoints)
  async runCheckNow() {
    await this.checkSubscriptions();
    return { ran: true, ts: new Date().toISOString() };
  }
}
