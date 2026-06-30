import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

@Injectable()
export class AttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  async checkIn(companyId: string, userId: string, lat: number, lng: number) {
    const today = new Date();
    const existing = await this.prisma.attendanceRecord.findFirst({
      where: {
        companyId,
        userId,
        checkInAt: { gte: startOfDay(today), lte: endOfDay(today) },
        checkOutAt: null,
      },
    });
    if (existing) throw new BadRequestException('لقد سجلت حضورك بالفعل اليوم');

    const branches = await this.prisma.branch.findMany({
      where: { companyId, isActive: true },
    });
    if (!branches.length) throw new NotFoundException('لا توجد فروع مسجلة للشركة');

    const nearest = branches.reduce((best, b) => {
      const d = haversineMeters(lat, lng, b.lat, b.lng);
      return d < haversineMeters(lat, lng, best.lat, best.lng) ? b : best;
    });

    const distance = haversineMeters(lat, lng, nearest.lat, nearest.lng);
    if (distance > nearest.radiusMeters) {
      throw new BadRequestException(
        `أنت بعيد عن الفرع (${Math.round(distance)} م). يجب أن تكون على بعد ${nearest.radiusMeters} م على الأكثر`,
      );
    }

    return this.prisma.attendanceRecord.create({
      data: {
        companyId,
        userId,
        branchId: nearest.id,
        checkInAt: new Date(),
        checkInLat: lat,
        checkInLng: lng,
      },
      include: { branch: { select: { name: true } }, user: { select: { name: true } } },
    });
  }

  async checkOut(companyId: string, userId: string, lat: number, lng: number) {
    const today = new Date();
    const record = await this.prisma.attendanceRecord.findFirst({
      where: {
        companyId,
        userId,
        checkInAt: { gte: startOfDay(today), lte: endOfDay(today) },
        checkOutAt: null,
      },
      include: { branch: true },
    });
    if (!record) throw new NotFoundException('لم يتم تسجيل حضور اليوم أو تم الانصراف مسبقاً');

    const distance = haversineMeters(lat, lng, record.branch.lat, record.branch.lng);
    if (distance > record.branch.radiusMeters) {
      throw new BadRequestException(
        `أنت بعيد عن الفرع (${Math.round(distance)} م). يجب أن تكون على بعد ${record.branch.radiusMeters} م على الأكثر`,
      );
    }

    return this.prisma.attendanceRecord.update({
      where: { id: record.id },
      data: { checkOutAt: new Date(), checkOutLat: lat, checkOutLng: lng },
      include: { branch: { select: { name: true } }, user: { select: { name: true } } },
    });
  }

  async myRecords(companyId: string, userId: string, date?: string) {
    const target = date ? new Date(date) : new Date();
    const start = new Date(target);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);

    return this.prisma.attendanceRecord.findMany({
      where: {
        companyId,
        userId,
        checkInAt: { gte: start, lte: endOfDay(target) },
      },
      include: { branch: { select: { name: true } } },
      orderBy: { checkInAt: 'desc' },
    });
  }

  async teamRecords(companyId: string, date?: string) {
    const target = date ? new Date(date) : new Date();
    return this.prisma.attendanceRecord.findMany({
      where: {
        companyId,
        checkInAt: { gte: startOfDay(target), lte: endOfDay(target) },
      },
      include: {
        user: { select: { name: true, role: true } },
        branch: { select: { name: true } },
      },
      orderBy: { checkInAt: 'asc' },
    });
  }

  async patchRecord(companyId: string, recordId: string, notes: string) {
    const record = await this.prisma.attendanceRecord.findFirst({
      where: { id: recordId, companyId },
    });
    if (!record) throw new NotFoundException('السجل غير موجود');
    return this.prisma.attendanceRecord.update({
      where: { id: recordId },
      data: { notes },
    });
  }

  async branches(companyId: string) {
    return this.prisma.branch.findMany({ where: { companyId, isActive: true } });
  }
}
