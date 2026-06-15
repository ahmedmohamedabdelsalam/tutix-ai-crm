import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

const WARN_DAYS = [14, 7, 3, 1];
const TOKEN_LIFETIME_DAYS = 60;

@Injectable()
export class TokenMonitorService {
  private readonly logger = new Logger(TokenMonitorService.name);

  constructor(private prisma: PrismaService) {}

  // Runs every day at 09:00 Cairo time (UTC+2 = 07:00 UTC)
  @Cron('0 7 * * *')
  async checkTokenExpiry() {
    this.logger.log('Running WhatsApp token expiry check...');

    const companies = await this.prisma.company.findMany({
      where: { isActive: true, waTokenUpdatedAt: { not: null } },
      select: { id: true, name: true, waTokenUpdatedAt: true },
    });

    let warned = 0;
    for (const company of companies) {
      const daysSince = Math.floor(
        (Date.now() - company.waTokenUpdatedAt!.getTime()) / 86_400_000,
      );
      const daysLeft = TOKEN_LIFETIME_DAYS - daysSince;

      if (WARN_DAYS.includes(daysLeft)) {
        await this.sendTokenWarning(company, daysLeft);
        warned++;
      }
    }

    this.logger.log(
      `Token expiry check done — ${companies.length} companies checked, ${warned} warnings sent`,
    );
  }

  async sendTokenWarning(
    company: { id: string; name: string },
    daysLeft: number,
  ) {
    this.logger.warn(
      `TOKEN_EXPIRY_WARNING: ${company.name} — ${daysLeft} day(s) left`,
    );

    // Avoid duplicate notifications for the same day
    const alreadySent = await this.prisma.systemNotification.findFirst({
      where: {
        companyId: company.id,
        type: 'TOKEN_EXPIRY',
        daysLeft,
        createdAt: { gte: new Date(Date.now() - 86_400_000) },
      },
    });
    if (alreadySent) return;

    await this.prisma.systemNotification.create({
      data: {
        companyId: company.id,
        type: 'TOKEN_EXPIRY',
        message: `تنبيه: توكن واتساب شركة ${company.name} سينتهي خلال ${daysLeft} يوم — يرجى التجديد`,
        daysLeft,
        isRead: false,
      },
    });
  }

  async runCheckNow() {
    await this.checkTokenExpiry();
    return { ran: true, ts: new Date().toISOString() };
  }
}
