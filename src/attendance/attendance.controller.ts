import {
  Controller, Post, Get, Patch, Body, Query, Param, Headers, UnauthorizedException,
} from '@nestjs/common';
import { AttendanceService } from './attendance.service';

function guardKey(apiKey: string) {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected || apiKey !== expected) throw new UnauthorizedException();
}

@Controller('attendance')
export class AttendanceController {
  constructor(private readonly svc: AttendanceService) {}

  @Post('check-in')
  async checkIn(
    @Headers('x-api-key') key: string,
    @Body() body: { companyId: string; userId: string; lat: number; lng: number },
  ) {
    guardKey(key);
    return this.svc.checkIn(body.companyId, body.userId, body.lat, body.lng);
  }

  @Post('check-out')
  async checkOut(
    @Headers('x-api-key') key: string,
    @Body() body: { companyId: string; userId: string; lat: number; lng: number },
  ) {
    guardKey(key);
    return this.svc.checkOut(body.companyId, body.userId, body.lat, body.lng);
  }

  @Get('my-records')
  async myRecords(
    @Headers('x-api-key') key: string,
    @Query('companyId') companyId: string,
    @Query('userId') userId: string,
    @Query('date') date?: string,
  ) {
    guardKey(key);
    return this.svc.myRecords(companyId, userId, date);
  }

  @Get('team')
  async team(
    @Headers('x-api-key') key: string,
    @Query('companyId') companyId: string,
    @Query('date') date?: string,
  ) {
    guardKey(key);
    return this.svc.teamRecords(companyId, date);
  }

  @Get('branches')
  async branches(
    @Headers('x-api-key') key: string,
    @Query('companyId') companyId: string,
  ) {
    guardKey(key);
    return this.svc.branches(companyId);
  }

  @Patch(':id')
  async patch(
    @Headers('x-api-key') key: string,
    @Param('id') id: string,
    @Body() body: { companyId: string; notes: string },
  ) {
    guardKey(key);
    return this.svc.patchRecord(body.companyId, id, body.notes);
  }
}
