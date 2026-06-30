import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { AttendanceModule } from './attendance/attendance.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    WhatsAppModule,
    SubscriptionModule,
    AttendanceModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
