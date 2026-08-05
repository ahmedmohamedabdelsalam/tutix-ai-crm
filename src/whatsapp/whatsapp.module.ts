import { Module } from '@nestjs/common'
import { WhatsAppController } from './whatsapp.controller'
import { WhatsAppService } from './whatsapp.service'
import { FollowUpService } from './followup.service'
import { SignatureStatsService } from './signature-stats.service'

@Module({
  controllers: [WhatsAppController],
  providers: [WhatsAppService, FollowUpService, SignatureStatsService],
})
export class WhatsAppModule {}
